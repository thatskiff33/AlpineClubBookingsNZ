import { prisma } from "./prisma";
import { formatDateOnly, parseDateOnly } from "./date-only";
import { lodgeNullTolerantScope } from "./lodges";

/**
 * Custodian occupancy (#2286, epic #2245) — THE single source of truth for
 * "which bed-nights are held by a custodian".
 *
 * A `HutLeaderAssignment` with a `bedId` is a **custodian bed hold**: for the
 * night of every covered date the bed is out of the bookable pool and out of
 * the allocatable pool, with no `Booking` and no `BedAllocation` row anywhere.
 * An assignment WITHOUT a bed — including every row
 * `cron-hut-leader-auto-assign.ts` creates — is a role only and has zero
 * capacity effect, exactly as before this feature existed.
 *
 * ## Night semantics (pinned)
 *
 * The hold covers `startDate <= night <= endDate` **inclusive**, matching the
 * existing hut-leader coverage semantics (the auto-assign cron and the admin
 * page band the same range). `2026-06-01 -> 2026-09-30` holds the nights of
 * 06-01..09-30; the bed is bookable again for the night of 10-01.
 *
 * This is deliberately NOT the half-open `[checkIn, checkOut)` booking
 * envelope: a booking's `checkOut` is a departure morning, an assignment's
 * `endDate` is a covered day. Converting between them is the caller's job —
 * `overlapsRange` below takes an EXCLUSIVE end so it composes with the
 * booking-shaped ranges the capacity engines already work in.
 *
 * ## ONE date-only convention (#2286 review L3)
 *
 * Every date in this module is a UTC-midnight date-only `Date`, keyed with
 * {@link formatDateOnly} and truncated with {@link truncateToDateOnly} — the
 * same convention the rest of the bed-allocation and capacity domain uses
 * (`eachDateOnlyInRange`, `addDaysDateOnly`, `parseDateOnly`, and the
 * `formatDateOnly` keys in `capacity.ts`). This module previously keyed with
 * `formatDateOnlyForTimeZone`, which agrees for a properly normalised
 * UTC-midnight input but silently disagrees for a LOCAL-midnight one — so a
 * caller building nights with a local-midnight helper would compare keys from
 * two different conventions and lose or gain a night. One convention, applied
 * everywhere, is what makes that class of bug impossible rather than merely
 * unlikely.
 *
 * ## Counting, never a boolean
 *
 * Two assignments may overlap by one day for handover, and the overlap is
 * allowed only on DIFFERENT beds (same-bed overlap is refused at write). On
 * the shared handover night two custodian beds are held, so every arithmetic
 * consumer here works in per-night COUNTS, never a boolean.
 *
 * ## Enforcement model
 *
 * Owner decision (28 Jul 2026): option (a), application-code exclusion. The
 * hold lives on the one assignment row; the allocation chokepoints call
 * {@link assertBedNightsFreeOfCustodianHold} / feed
 * {@link custodianOccupiedBedNightsForPlanner} — and, because a planner's read
 * is not its write, every one of them ALSO re-reads the holds (via
 * {@link custodianHeldBedNightKeys}) on the client that is about to write,
 * immediately before writing. Each placement transaction the app opens itself
 * takes the per-lodge advisory lock (`acquireLodgeCapacityLock`) first, so that
 * re-read and the write serialise against booking admission and against the
 * hold writer, which takes the same key. Option (b) — nullable-FK `BedAllocation`
 * rows — was weighed and rejected (blue/green break on a runtime-hot table,
 * ~30 read sites needing a null-tolerance audit, and the lifecycle prune
 * silently deleting custodian rows as orphans). See docs/CAPACITY_MODEL.md.
 */

type PrismaClient = typeof prisma;
type CustodianDb = Pick<PrismaClient, "hutLeaderAssignment">;

/** A bed-holding hut-leader assignment, resolved for capacity/allocation use. */
export interface CustodianBedHold {
  assignmentId: string;
  memberId: string;
  memberName: string;
  /** Minor-age custodians are never individually named on a public surface. */
  memberIsMinor: boolean;
  lodgeId: string;
  bedId: string;
  bedName: string;
  roomId: string;
  roomName: string;
  /** Inclusive first held night, `YYYY-MM-DD`. */
  startDate: string;
  /** Inclusive last held night, `YYYY-MM-DD`. */
  endDate: string;
}

const MINOR_AGE_TIERS = new Set(["INFANT", "CHILD", "YOUTH"]);

/**
 * Truncate a `Date` to its UTC date-only midnight — this module's ONE
 * convention (see the note at the top of the file).
 *
 * `formatDateOnly` is `toISOString().slice(0, 10)`, so this is exactly the
 * inverse-then-forward round trip and is a no-op for a date that is already a
 * date-only value.
 */
function truncateToDateOnly(date: Date): Date {
  return parseDateOnly(formatDateOnly(date));
}

/**
 * Is this age tier a minor? Exported because the custodian slot on the lobby
 * TV must never individually name a minor at ANY granularity (the display
 * contract in lodge-display-state.ts), and the hut-leaders API warns the admin
 * at assignment time rather than letting them assume a name will appear.
 */
export function isMinorAgeTier(ageTier: string | null | undefined): boolean {
  return ageTier ? MINOR_AGE_TIERS.has(ageTier) : false;
}

/**
 * Does a hold cover any night of `[from, toExclusive)`?
 *
 * The hold's own range is inclusive-inclusive, so it overlaps a half-open
 * booking-shaped window when `startDate < toExclusive` and `endDate >= from`.
 * Pure string comparison on `YYYY-MM-DD` keys — no timezone conversion.
 */
export function holdOverlapsRange(
  hold: Pick<CustodianBedHold, "startDate" | "endDate">,
  fromKey: string,
  toExclusiveKey: string,
): boolean {
  return hold.startDate < toExclusiveKey && hold.endDate >= fromKey;
}

/** Does a hold cover the night of `nightKey` (`YYYY-MM-DD`)? */
export function holdCoversNight(
  hold: Pick<CustodianBedHold, "startDate" | "endDate">,
  nightKey: string,
): boolean {
  return hold.startDate <= nightKey && nightKey <= hold.endDate;
}

/**
 * Is this bed-night held by a custodian? (`INV-CAP-038`, #2698.)
 *
 * THE predicate a whole-lodge hold subtracts through. ADR-001 says an
 * exclusive hold gives its group the whole lodge, and until #2698 that was
 * taken literally: the hold's represented bed set was *every* active bed,
 * including the one a custodian is sleeping in, so the same bed-night was
 * claimed twice — once by the hold and once by the custodian term. The owner's
 * rule (9 Aug 2026) is that the hold's set **excludes** custodian-held
 * bed-nights for each overlapping night, which makes the two disjoint and
 * makes `docs/CAPACITY_MODEL.md`'s long-standing claim that the custodian's
 * bed sits outside the held pool true instead of false.
 *
 * The rule is written once, here, and reached from both places that decide
 * what a hold covers:
 *
 * - the bed-allocation planners, through
 *   `wholeLodgeHoldOccupiedBedNightsForPlanner`
 *   (`src/lib/exclusive-hold-occupancy.ts`), which skips a bed-night this
 *   returns true for rather than emitting a hold row for it;
 * - the custodian write path's ordering-case check
 *   (`findWholeLodgeHoldAmendments`, `src/lib/custodian-assignment.ts`), which
 *   asks which nights a NEW custodian hold would take out of an existing
 *   hold's set — and does not re-ask for a bed-night the same assignment
 *   already holds, because that one left the set when it was first created.
 *
 * The capacity engines work in per-night COUNTS rather than bed sets, so they
 * subtract the same fact through the same loaded holds in its count shape —
 * `buildCustodianNightIndex` / `buildLodgeCustodianNightCounter` above, fed to
 * `wholeLodgeHoldRepresentedBeds` in `capacity.ts`. One source
 * (`findCustodianBedHolds` + {@link holdCoversNight}), two views of it; never a
 * second inventory of which beds a custodian has.
 *
 * No lodge argument: a bed belongs to exactly one lodge and `bedId` is unique,
 * so a matching bed id IS a matching lodge. Scoping is the loaders' job.
 */
export function isCustodianHeldBedNight(
  holds: readonly CustodianBedHold[],
  bedId: string,
  nightKey: string,
): boolean {
  return holds.some(
    (hold) => hold.bedId === bedId && holdCoversNight(hold, nightKey),
  );
}

/**
 * Load the custodian bed holds overlapping a half-open date window.
 *
 * `toExclusive` is EXCLUSIVE so callers can pass the booking-shaped
 * `[checkIn, checkOut)` window they already hold; the inclusive-endDate
 * semantics are handled here.
 *
 * Only rows with a bed are returned — a bed-less assignment is not an
 * occupancy and must never influence capacity or allocation.
 */
export async function findCustodianBedHolds(input: {
  lodgeId?: string;
  bedIds?: string[];
  from: Date;
  toExclusive: Date;
  db?: CustodianDb;
}): Promise<CustodianBedHold[]> {
  const db = input.db ?? prisma;
  const from = truncateToDateOnly(input.from);
  const toExclusive = truncateToDateOnly(input.toExclusive);

  if (input.bedIds && input.bedIds.length === 0) return [];
  if (from >= toExclusive) return [];

  const rows = await db.hutLeaderAssignment.findMany({
    where: {
      // `not: null` is the whole feature gate: a role-only assignment can
      // never reach a capacity or allocation consumer.
      bedId: input.bedIds ? { in: input.bedIds } : { not: null },
      // Inclusive endDate vs exclusive window end, as documented above.
      startDate: { lt: toExclusive },
      endDate: { gte: from },
      ...(input.lodgeId ? lodgeNullTolerantScope(input.lodgeId) : {}),
    },
    select: {
      id: true,
      memberId: true,
      lodgeId: true,
      bedId: true,
      startDate: true,
      endDate: true,
      member: { select: { firstName: true, lastName: true, ageTier: true } },
      bed: {
        select: {
          id: true,
          name: true,
          roomId: true,
          room: { select: { id: true, name: true } },
        },
      },
    },
    orderBy: [{ startDate: "asc" }, { id: "asc" }],
  });

  const holds: CustodianBedHold[] = [];
  for (const row of rows) {
    // `bed` is non-null whenever `bedId` is, but the Prisma types cannot know
    // that from a `{ not: null }` filter — narrow rather than assert.
    if (!row.bedId || !row.bed) continue;
    holds.push({
      assignmentId: row.id,
      memberId: row.memberId,
      memberName:
        `${row.member.firstName ?? ""} ${row.member.lastName ?? ""}`.trim(),
      memberIsMinor: isMinorAgeTier(row.member.ageTier),
      lodgeId: row.lodgeId,
      bedId: row.bedId,
      bedName: row.bed.name,
      roomId: row.bed.roomId,
      roomName: row.bed.room.name,
      startDate: formatDateOnly(row.startDate),
      endDate: formatDateOnly(row.endDate),
    });
  }
  return holds;
}

/**
 * Per-night custodian head COUNT for a set of holds.
 *
 * A count, not a flag: two custodians handing over on the same night hold two
 * beds and subtract two. Keys are `YYYY-MM-DD`; nights with no hold are absent
 * from the map (callers use `?? 0`).
 */
export function buildCustodianNightIndex(
  holds: readonly Pick<CustodianBedHold, "startDate" | "endDate">[],
  nights: readonly Date[],
): Map<string, number> {
  const index = new Map<string, number>();
  if (holds.length === 0) return index;
  for (const night of nights) {
    const key = formatDateOnly(night);
    let count = 0;
    for (const hold of holds) {
      if (holdCoversNight(hold, key)) count += 1;
    }
    if (count > 0) index.set(key, count);
  }
  return index;
}

/**
 * The custodian head count on one night for a lodge, as a ready-to-use
 * `(night) => number` closure. The four admission/availability engines and the
 * capacity-warnings cron all add this to `occupiedBeds`.
 *
 * Counted as an OCCUPANT rather than as a reduction of `lodgeCapacity`: the
 * arithmetic for `availableBeds` is identical, but it preserves
 * `occupiedBeds + availableBeds === lodgeCapacity` on every night (the #155
 * payload contract) and makes every `capacity - occupied` consumer correct
 * with no consumer change and no identity leak. It is also semantically right
 * under a capped capacity (`capped_beds`): a licence cap is a sleeping cap,
 * and the custodian sleeps in the lodge.
 */
export async function buildLodgeCustodianNightCounter(input: {
  lodgeId: string;
  from: Date;
  toExclusive: Date;
  nights: readonly Date[];
  db?: CustodianDb;
  /**
   * Ignore one assignment's own hold — used when the caller is evaluating what
   * occupancy would be with that assignment counted exactly once, by itself
   * (the custodian write path's over-capacity warning). Filtered in memory for
   * the same reason `custodianHeldNightsForBed` does it: the exclusion is a
   * caller concern, not part of the "which beds are held" query.
   */
  excludeAssignmentId?: string;
}): Promise<(night: Date) => number> {
  const loaded = await findCustodianBedHolds({
    lodgeId: input.lodgeId,
    from: input.from,
    toExclusive: input.toExclusive,
    db: input.db,
  });
  const holds = input.excludeAssignmentId
    ? loaded.filter((hold) => hold.assignmentId !== input.excludeAssignmentId)
    : loaded;
  const index = buildCustodianNightIndex(holds, input.nights);
  if (index.size === 0) return () => 0;
  return (night: Date) => index.get(formatDateOnly(night)) ?? 0;
}

/**
 * Which of `stayDates` are held by a custodian on `bedId`, as sorted
 * `YYYY-MM-DD` keys. Empty when the bed is free on all of them.
 */
export async function custodianHeldNightsForBed(input: {
  bedId: string;
  stayDates: readonly Date[];
  db?: CustodianDb;
  /** Ignore this assignment's own hold — used when editing it. */
  excludeAssignmentId?: string;
}): Promise<string[]> {
  if (input.stayDates.length === 0) return [];
  const keys = input.stayDates.map((date) => formatDateOnly(date)).sort();
  // The window bounds are the MIN and MAX of the set, never `stayDates[0]`
  // (#2286 review L2): a caller that passes an unsorted or non-contiguous night
  // list — which the bulk and range paths legitimately do (#713) — would
  // otherwise get a window starting AFTER some of the nights it asked about, and
  // a hold covering those earlier nights would be read as absent.
  const normalized = input.stayDates.map(truncateToDateOnly);
  const from = normalized.reduce((a, b) => (a < b ? a : b));
  const latest = normalized.reduce((a, b) => (a > b ? a : b));
  const toExclusive = new Date(latest.getTime() + 24 * 60 * 60 * 1000);

  const holds = await findCustodianBedHolds({
    bedIds: [input.bedId],
    from,
    toExclusive,
    db: input.db,
  });
  const applicable = input.excludeAssignmentId
    ? holds.filter((hold) => hold.assignmentId !== input.excludeAssignmentId)
    : holds;
  if (applicable.length === 0) return [];

  const held = new Set<string>();
  for (const key of keys) {
    if (applicable.some((hold) => holdCoversNight(hold, key))) held.add(key);
  }
  return [...held].sort();
}

/**
 * Error thrown by every allocation chokepoint that refuses to place a guest
 * onto a custodian-held bed-night.
 *
 * Deliberately its own class rather than `BedAllocationAdminError`: this
 * module sits UNDER the admin bed-allocation modules (which import it), so importing
 * that error type back would be a cycle. Each chokepoint maps this to its own
 * refusal shape — a 409 for the single-night path, a per-night
 * `CUSTODIAN_HOLD` conflict entry for the bulk/range paths.
 */
export class CustodianHoldConflictError extends Error {
  readonly status = 409;
  constructor(
    message: string,
    /** The refused nights, sorted `YYYY-MM-DD`. */
    readonly heldNights: string[],
  ) {
    super(message);
    this.name = "CustodianHoldConflictError";
  }
}

/**
 * Refuse to place anything on a bed-night a custodian holds.
 *
 * THE guard, called from `allocateBedNightWithLocksHeld` — the single upsert funnel every
 * manual placement (single-night, bulk, board move, range assign) reaches. Its
 * callers hold the per-lodge advisory lock, so a hold created concurrently
 * either commits before this read (and is seen) or waits behind it (and sees
 * the allocation).
 */
export async function assertBedNightsFreeOfCustodianHold(input: {
  bedId: string;
  stayDates: readonly Date[];
  db?: CustodianDb;
}): Promise<void> {
  const held = await custodianHeldNightsForBed(input);
  if (held.length === 0) return;
  throw new CustodianHoldConflictError(
    `That bed is held by a hut-leader assignment on ${held.join(", ")}. Change that assignment on the Hut Leaders page first.`,
    held,
  );
}

/**
 * Expand custodian holds into planner `occupiedBedNights` rows.
 *
 * Fed to `buildFirstFitBedAllocationPlan` as #1768 "unknown occupant" rows
 * (null `bookingId`/`bookingGuestId`): blocking, never evictable, and
 * conservative for room mix. "Never evictable" holds for the BED-NIGHT and not
 * just for the row: a hut-leader assignment can be created for a bed that
 * already carries an allocation, and planner occupancy is keyed
 * `bedId:stayDate`, so the planner pins every null-booking bed-night in
 * `state.permanentlyOccupied` and evicting the co-located booking never hands
 * the custodian's bed to anyone (#2317 review). The room-mix side effect is INTENDED and
 * documented in docs/CAPACITY_MODEL.md — the custodian's room reads as
 * containing an out-of-booking adult, so auto-placement keeps other bookings'
 * unaccompanied minors out of that room for the season. An unrelated adult
 * really does sleep there.
 *
 * `ageTier` is deliberately omitted rather than taken from the member: the
 * planner treats a tierless unknown occupant as an adult, which is both the
 * conservative reading and the one that does not leak a custodian's age tier
 * into a planner input.
 */
export function custodianOccupiedBedNightsForPlanner(
  holds: readonly CustodianBedHold[],
  nights: readonly Date[],
): Array<{
  bedId: string;
  roomId: string;
  stayDate: string;
  bookingId: null;
  bookingGuestId: null;
}> {
  if (holds.length === 0) return [];
  const rows: Array<{
    bedId: string;
    roomId: string;
    stayDate: string;
    bookingId: null;
    bookingGuestId: null;
  }> = [];
  for (const night of nights) {
    const key = formatDateOnly(night);
    for (const hold of holds) {
      if (!holdCoversNight(hold, key)) continue;
      rows.push({
        bedId: hold.bedId,
        roomId: hold.roomId,
        stayDate: key,
        bookingId: null,
        bookingGuestId: null,
      });
    }
  }
  return rows;
}

/**
 * Every `(bedId, night)` pair a custodian holds, as `bedId:YYYY-MM-DD` keys —
 * the cheap set form used to re-filter planner suggestions before a write.
 */
export function custodianHeldBedNightKeys(
  holds: readonly CustodianBedHold[],
  nights: readonly Date[],
): Set<string> {
  const keys = new Set<string>();
  for (const night of nights) {
    const key = formatDateOnly(night);
    for (const hold of holds) {
      if (holdCoversNight(hold, key)) keys.add(`${hold.bedId}:${key}`);
    }
  }
  return keys;
}

/**
 * Does any custodian hold reference one of these beds at all (any date)?
 * Used by the bed/room DELETE guards, which refuse on ANY hold rather than
 * only future ones — the FK is Restrict, so a delete would otherwise fail with
 * a raw P2003 the admin cannot act on.
 */
export async function findAnyCustodianHoldsForBeds(input: {
  bedIds: string[];
  db?: CustodianDb;
}): Promise<
  Array<{ assignmentId: string; bedId: string; startDate: string; endDate: string }>
> {
  if (input.bedIds.length === 0) return [];
  const db = input.db ?? prisma;
  const rows = await db.hutLeaderAssignment.findMany({
    where: { bedId: { in: input.bedIds } },
    select: { id: true, bedId: true, startDate: true, endDate: true },
    orderBy: [{ startDate: "asc" }, { id: "asc" }],
  });
  return rows.flatMap((row) =>
    row.bedId
      ? [
          {
            assignmentId: row.id,
            bedId: row.bedId,
            startDate: formatDateOnly(row.startDate),
            endDate: formatDateOnly(row.endDate),
          },
        ]
      : [],
  );
}

/**
 * Custodian holds on a bed that cover any night from today onwards — the
 * DEACTIVATE guard's population (deactivating a bed only has to be safe going
 * forward; past coverage is history).
 */
export async function findFutureCustodianHoldsForBed(input: {
  bedId: string;
  today: Date;
  db?: CustodianDb;
}): Promise<Array<{ assignmentId: string; startDate: string; endDate: string }>> {
  const db = input.db ?? prisma;
  const rows = await db.hutLeaderAssignment.findMany({
    where: { bedId: input.bedId, endDate: { gte: input.today } },
    select: { id: true, startDate: true, endDate: true },
    orderBy: [{ startDate: "asc" }, { id: "asc" }],
  });
  return rows.map((row) => ({
    assignmentId: row.id,
    startDate: formatDateOnly(row.startDate),
    endDate: formatDateOnly(row.endDate),
  }));
}
