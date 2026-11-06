import type { AgeTier } from "@prisma/client";
import { z } from "zod";

import { bookableAgeTierEnum } from "@/lib/age-tier-schema";
import { addCalendarDays, calendarDateOfDateOnlyInstant, countClubNights, parseCalendarDate } from "@/lib/club-time";
import type { BatchModifyInput } from "@/lib/booking-modify";
import {
  guestNightKeys,
  isAppliedChangeRequestRange,
  isEffectiveStayRangeChange,
  nightsKeptByRepeatedRange,
  storedGuestNightsAsDays,
  type GuestNightsAsDays,
} from "@/lib/booking-change-request-guests";
import type { ChangeRequestDelta } from "@/lib/booking-change-request-input";
import {
  promoChangeBatchFields,
  promoChangeCodes,
  storedPromoChangeSchema,
} from "@/lib/booking-change-request-promo";
import { guestName } from "@/lib/bed-allocation-display-names";
import { collapseNightRuns } from "@/lib/bed-allocation-board-window";
import { guestNightListSchema } from "@/lib/booking-guest-stay-range-input";
import { effectiveStayRangeByGuest } from "@/lib/booking-modification-stay-ranges";

/**
 * A LOCKED_PERIOD change request's stored `requestedChanges`, read back, and
 * what it asks the booking to become (#3750). Moved out of
 * `booking-change-request-execution.ts` (#4030) so the admin list can ask
 * "does this request name a change?" through the executor's own mapping
 * without loading the batch modification service.
 */

// ---------------------------------------------------------------------------
// The stored request
// ---------------------------------------------------------------------------

const optionalDate = z.string().nullish();
/**
 * A guest's explicit night set (#713) as stored (#4088), read by the request's
 * own schema so a malformed night makes the row unreadable rather than throwing
 * later. Absent on rows written before grid-mode requests kept their nights.
 */
const optionalNights = guestNightListSchema.nullish();

/**
 * What `POST /api/bookings/[id]/change-requests` writes into
 * `requestedChanges`, read back defensively: the column is JSON and older rows
 * predate some fields, so anything this cannot parse is refused as unreadable
 * rather than half-executed.
 */
export const storedLockedPeriodRequestSchema = z.object({
  original: z.object({
    checkIn: z.string(),
    checkOut: z.string(),
    // The guest's stored range is read when present (#4030 review M2), so a
    // range repeating it is not mistaken for a change.
    // #4088: and the guest's night rows, so a grid night set repeating them is
    // not a change, and approval sees a night trimmed since as drift.
    guests: z.array(
      z.object({
        id: z.string(),
        stayStart: z.string().nullish(),
        stayEnd: z.string().nullish(),
        nights: optionalNights,
        // Shown to the officer beside the nights asked for (#4088).
        firstName: z.string().nullish(),
        lastName: z.string().nullish(),
      }),
    ),
    // #4533: the booking's codes a promo change was entered against, so
    // approval sees a code applied or released since as drift.
    promoCodes: z.array(z.string()).nullish(),
  }),
  requested: z.object({
    checkIn: optionalDate,
    checkOut: optionalDate,
    addGuests: z
      .array(
        z.object({
          firstName: z.string(),
          lastName: z.string(),
          ageTier: bookableAgeTierEnum,
          isMember: z.boolean(),
          memberId: z.string().nullish(),
          stayStart: optionalDate,
          stayEnd: optionalDate,
          nights: optionalNights,
        }),
      )
      .default([]),
    removeGuests: z.array(z.object({ id: z.string() })).default([]),
    guestStayRanges: z
      .array(
        z.object({
          guestId: z.string(),
          stayStart: optionalDate,
          stayEnd: optionalDate,
          nights: optionalNights,
        }),
      )
      .default([]),
    /**
     * #4533: the promo change an officer entered on the member's behalf, for a
     * finished stay (`booking-change-request-promo.ts`). Absent on every member
     * request and on rows written before it existed.
     */
    promoChange: storedPromoChangeSchema.nullish(),
  }),
  /**
   * #4157: written by an approval's guarded claim, whether it applies the
   * request or only acknowledges it (`acknowledgedKeptNightsRecord`) — each
   * guest whose repeated range keeps the nights they held, with those nights
   * (`INV-REQ-012`). Present, even empty, only on a request
   * approved under that rule, so the officer's card can tell it from one
   * approved before this release, which filled the gaps instead. A top-level
   * key the older schema strips, so a previous colour still reads the row.
   */
  keptNights: z.array(z.object({ guestId: z.string(), nights: guestNightListSchema })).nullish(),
});

export type StoredLockedPeriodRequest = z.infer<typeof storedLockedPeriodRequestSchema>;

/**
 * A booking guest's live range and night rows, as the executor reads them
 * under its locks and the admin list reads them for the officer's card.
 */
export interface LiveRequestGuestRow {
  id: string;
  stayStart: Date;
  stayEnd: Date;
  nights?: ReadonlyArray<{ stayDate: Date }> | null;
}

/**
 * The nights a repeated range is judged against (#4157, `INV-REQ-012`): the
 * guest's live rows when the caller read them, else the request's own snapshot
 * of the guest. One source for approval and for the officer's card, so the
 * card never shows nights the approval would not keep.
 */
function keptNightsSource(
  guestId: string,
  liveGuests: ReadonlyArray<LiveRequestGuestRow> | undefined,
  snapshot: GuestNightsAsDays | undefined,
): GuestNightsAsDays | undefined {
  const live = liveGuests?.find((guest) => guest.id === guestId);
  return live ? storedGuestNightsAsDays(live) : snapshot;
}

/** Each snapshotted guest's own range and night rows, by guest id. */
function snapshotRanges(stored: StoredLockedPeriodRequest): Map<string, GuestNightsAsDays> {
  return new Map(
    stored.original.guests.flatMap((guest) =>
      guest.stayStart && guest.stayEnd
        ? [[guest.id, { stayStart: guest.stayStart, stayEnd: guest.stayEnd, nights: guest.nights }] as const]
        : [],
    ),
  );
}

/**
 * The guest ranges a stored request applies: both bounds or a night set, for a
 * guest it does not also remove.
 */
type AppliedRange = {
  guestId: string;
  stayStart: string | null;
  stayEnd: string | null;
  nights?: string[];
};

function appliedRanges(stored: StoredLockedPeriodRequest): AppliedRange[] {
  const removed = new Set(stored.requested.removeGuests.map((guest) => guest.id));
  return (
    stored.requested.guestStayRanges
      .filter(isAppliedChangeRequestRange)
      // A range for a guest the same request removes is moot, and the planner
      // would refuse it as naming a guest no longer on the booking.
      .filter((range) => !removed.has(range.guestId))
      .map((range) => ({
        guestId: range.guestId,
        stayStart: range.stayStart ?? null,
        stayEnd: range.stayEnd ?? null,
        ...(range.nights?.length ? { nights: range.nights } : {}),
      }))
  );
}

/**
 * #4157 (owner decision "Keep their nights", `INV-REQ-012`): each guest whose
 * EFFECTIVE applied range — the entry the planner applies, the last one for
 * that guest (`effectiveStayRangeByGuest`) — only repeats their own Date In and
 * Date Out, with the nights they keep, read from `liveGuests` (else the
 * snapshot). An earlier entry the planner ignores is never judged: a repeat
 * followed by a moved range or a night set is a change, and keeps nothing.
 * The batch input passes these nights to the planner on that entry; an
 * approval records them on the request (`withKeptNightsRecord`).
 */
export function keptNightsByGuest(
  stored: StoredLockedPeriodRequest,
  liveGuests: ReadonlyArray<LiveRequestGuestRow> | undefined,
): Map<string, string[]> {
  return keptNightsOfEffectiveRanges(
    effectiveStayRangeByGuest(appliedRanges(stored)),
    snapshotRanges(stored),
    liveGuests,
  );
}

function keptNightsOfEffectiveRanges(
  effective: ReadonlyMap<string, AppliedRange>,
  snapshot: ReadonlyMap<string, GuestNightsAsDays>,
  liveGuests: ReadonlyArray<LiveRequestGuestRow> | undefined,
): Map<string, string[]> {
  return new Map(
    [...effective.values()].flatMap((range) => {
      const kept = nightsKeptByRepeatedRange(
        range,
        keptNightsSource(range.guestId, liveGuests, snapshot.get(range.guestId)),
      );
      return kept ? [[range.guestId, kept] as const] : [];
    }),
  );
}

/**
 * The request's stored `requestedChanges` with the applying approval's record
 * of the nights each guest kept (#4157) written at the top level, beside
 * `original` and `requested`. Written by the guarded claim, so it exists only
 * alongside the approval that applied it.
 */
export function withKeptNightsRecord(
  requestedChanges: unknown,
  kept: ReadonlyMap<string, ReadonlyArray<string>>,
): Record<string, unknown> {
  const stored =
    typeof requestedChanges === "object" && requestedChanges !== null && !Array.isArray(requestedChanges)
      ? (requestedChanges as Record<string, unknown>)
      : {};
  return {
    ...stored,
    keptNights: [...kept].map(([guestId, nights]) => ({ guestId, nights: [...nights] })),
  };
}

/**
 * #4157: the record an approval that ACKNOWLEDGES a request (a running stay,
 * nothing applied) writes in its claim, so the officer's card reads the
 * decided request as it read while pending: `withKeptNightsRecord` over
 * `keptNightsByGuest`, against `liveGuests`. `null` for a row the request's own
 * schema cannot read, which is left as it is.
 */
export function acknowledgedKeptNightsRecord(
  requestedChanges: unknown,
  liveGuests: ReadonlyArray<LiveRequestGuestRow>,
): Record<string, unknown> | null {
  const stored = storedLockedPeriodRequestSchema.safeParse(requestedChanges);
  return stored.success ? withKeptNightsRecord(requestedChanges, keptNightsByGuest(stored.data, liveGuests)) : null;
}

/**
 * The canonical batch input a stored request asks for, or `null` when it asks
 * for nothing the booking can be changed by — a request that only named an
 * effective date, or whose dates equal the booking's own.
 *
 * The executor and `storedRequestNamesNoChange` are its callers. The executor
 * passes the booking's live guest rows, read under its locks, so a guest's
 * kept nights (#4157) are the ones they hold now; without them the request's
 * own snapshot of the guest's nights is read.
 */
export function lockedPeriodRequestToBatchInput(
  stored: StoredLockedPeriodRequest,
  booking: {
    checkIn: Date;
    checkOut: Date;
    guests?: ReadonlyArray<LiveRequestGuestRow>;
  },
): Pick<
  BatchModifyInput,
  | "checkIn"
  | "checkOut"
  | "addGuests"
  | "removeGuestIds"
  | "guestStayRanges"
  | "promoCode"
  | "promoGuestIds"
  | "promoCodes"
> | null {
  const currentCheckIn = calendarDateOfDateOnlyInstant(booking.checkIn);
  const currentCheckOut = calendarDateOfDateOnlyInstant(booking.checkOut);
  const { requested } = stored;
  const checkIn =
    requested.checkIn && requested.checkIn !== currentCheckIn
      ? requested.checkIn
      : undefined;
  const checkOut =
    requested.checkOut && requested.checkOut !== currentCheckOut
      ? requested.checkOut
      : undefined;
  const removeGuestIds = requested.removeGuests.map((guest) => guest.id);
  const currentRanges = snapshotRanges(stored);
  // Every two-bound range for a guest who stays is passed through, unchanged
  // ones included (#4030 re-review of 72c933ffc): a stored range is how the
  // planner keeps a part-stay guest's own nights when the envelope moves. Drop
  // the unchanged ones and a request that only shortens the stay and removes a
  // guest leaves range mode, so every remaining guest is stretched to the new
  // envelope and charged for nights they never stayed.
  //
  // #4088: a grid-mode range is the guest's night set, passed through as the
  // planner's `nights` (#713) — the same writer the editor's grid uses — so
  // approval applies, and prices, exactly the nights the member chose.
  const requestedRanges = appliedRanges(stored);
  const addGuests = requested.addGuests.map((guest) => ({
    firstName: guest.firstName,
    lastName: guest.lastName,
    ageTier: guest.ageTier as AgeTier,
    isMember: guest.isMember,
    ...(guest.memberId ? { memberId: guest.memberId } : {}),
    stayStart: guest.stayStart ?? null,
    stayEnd: guest.stayEnd ?? null,
    ...(guest.nights?.length ? { nights: guest.nights } : {}),
  }));
  // The entry the planner applies for each guest: the last (#4157).
  const effective = effectiveStayRangeByGuest(requestedRanges);
  // #4030 review M2: whether the request names nothing is judged on the ranges
  // that CHANGE something — a range repeating the guest's stored nights is not
  // a change. This test decides only that; it never filters what is applied.
  // It reads each guest's applied entry as the member sent it, before #4157
  // below, so an earlier duplicate the planner ignores is not a change.
  const namesRangeChange = [...effective.values()].some((range) =>
    isEffectiveStayRangeChange(range, currentRanges.get(range.guestId)),
  );
  // #4157 (owner decision "Keep their nights"): a two-bound range that only
  // repeats a gapped guest's own Date In and Date Out is applied as the nights
  // they hold, so approval neither fills nor charges their gaps. It stays in
  // the list, as an explicit night set, for the reason above: range mode must
  // not switch off. A range that moves a bound is applied as written.
  // Only on the entry the planner applies for that guest — the last — so an
  // earlier repeat can never overwrite a later moved range or night set.
  const kept = keptNightsOfEffectiveRanges(effective, currentRanges, booking.guests);
  const guestStayRanges = requestedRanges.map((range) => {
    const nights = effective.get(range.guestId) === range ? kept.get(range.guestId) : undefined;
    return nights ? { ...range, nights } : range;
  });
  // #4533: an officer's promo change, in the batch edit's own fields.
  const promoChange = requested.promoChange ?? null;
  if (
    !checkIn &&
    !checkOut &&
    addGuests.length === 0 &&
    removeGuestIds.length === 0 &&
    !namesRangeChange &&
    !promoChange
  ) {
    return null;
  }
  return {
    ...(checkIn ? { checkIn } : {}),
    ...(checkOut ? { checkOut } : {}),
    ...(addGuests.length > 0 ? { addGuests } : {}),
    ...(removeGuestIds.length > 0 ? { removeGuestIds } : {}),
    ...(guestStayRanges.length > 0 ? { guestStayRanges } : {}),
    ...(promoChange ? promoChangeBatchFields(promoChange) : {}),
  };
}

/**
 * #4533: whether a stored request's ONLY change is its promo change — the one
 * shape whose change email the approving officer may withhold. Judged through
 * the one mapping, with the promo change taken out.
 */
export function storedRequestNamesOnlyPromoChange(
  stored: StoredLockedPeriodRequest,
  booking: { checkIn: Date; checkOut: Date; guests?: ReadonlyArray<LiveRequestGuestRow> },
): boolean {
  if (!stored.requested.promoChange) return false;
  return (
    lockedPeriodRequestToBatchInput(
      { ...stored, requested: { ...stored.requested, promoChange: null } },
      booking,
    ) === null
  );
}

/**
 * #4203 (`INV-SSOT-001`): the approval-relevant `original` and `requested`
 * parts of a change request, as submission stores them and as the card's
 * estimate reads a proposal not yet stored. One builder, so the estimate sees
 * the same removals (only guests on the booking, each once, in booking order),
 * applied ranges (`isAppliedChangeRequestRange`) and snapshot nights approval
 * will. `describe` adds the officer-facing fields submission keeps beside each
 * booking guest (names, tier, member); the estimate needs none. Unknown guest
 * ids are the caller's to refuse first (`unknownChangeRequestGuestRefusal`).
 */
export function changeRequestStoredProposal<
  G extends LiveRequestGuestRow,
  // The builder's own keys stay the builder's: a `describe` that returned one
  // would silently overwrite it in the stored row (#4203 review).
  D extends object & Partial<Record<"id" | "stayStart" | "stayEnd" | "nights", never>> = Record<never, never>,
>(
  booking: { checkIn: Date; checkOut: Date; guests: ReadonlyArray<G> },
  delta: Pick<ChangeRequestDelta, "checkIn" | "checkOut" | "addGuests" | "removeGuestIds" | "guestStayRanges">,
  describe: (guest: G) => D = () => ({}) as D,
) {
  const removeSet = new Set(delta.removeGuestIds ?? []);
  return {
    original: {
      checkIn: calendarDateOfDateOnlyInstant(booking.checkIn),
      checkOut: calendarDateOfDateOnlyInstant(booking.checkOut),
      guests: booking.guests.map((guest) => {
        // `stayStart`, `stayEnd` and (#4088) the night rows approval's drift check compares.
        const { stayStart, stayEnd, nights } = storedGuestNightsAsDays(guest);
        return { id: guest.id, ...describe(guest), stayStart, stayEnd, nights };
      }),
    },
    requested: {
      checkIn: delta.checkIn ?? null,
      checkOut: delta.checkOut ?? null,
      addGuests: delta.addGuests ?? [],
      // #4157: only what approval applies is stored.
      guestStayRanges: (delta.guestStayRanges ?? []).filter(isAppliedChangeRequestRange),
      removeGuests: booking.guests
        .filter((guest) => removeSet.has(guest.id))
        .map((guest) => ({
          id: guest.id,
          ...describe(guest),
          stayStart: calendarDateOfDateOnlyInstant(guest.stayStart),
          stayEnd: calendarDateOfDateOnlyInstant(guest.stayEnd),
        })),
    },
  };
}

/**
 * #4203: the batch input a proposal not yet stored asks for — the merged
 * editor-and-card delta submission is about to write (`INV-REQ-011`) — built by
 * submission's own builder and read through the one mapping approval applies
 * to the stored row, so a pre-approval surface (the card's estimate) sees what
 * approval will, kept nights included (`INV-REQ-012`). `null` when it names
 * no change.
 */
export function changeRequestProposalBatchInput(
  booking: { checkIn: Date; checkOut: Date; guests: ReadonlyArray<LiveRequestGuestRow> },
  proposal: Parameters<typeof changeRequestStoredProposal>[1],
): ReturnType<typeof lockedPeriodRequestToBatchInput> {
  const { original, requested } = changeRequestStoredProposal(booking, proposal);
  return lockedPeriodRequestToBatchInput({ original, requested }, booking);
}

/**
 * #4030: whether a stored request names nothing the booking can be changed by —
 * the free-text requests the officer may enter guests for on approval. `false`
 * for an unreadable row (there is no telling what it asks), so the officer is
 * never offered an entry the executor would refuse as unreadable.
 *
 * Asked by the admin list (`acceptsOfficerGuests`) and by the executor, through
 * the one mapping (`lockedPeriodRequestToBatchInput`), so they cannot disagree.
 */
export function storedRequestNamesNoChange(
  requestedChanges: unknown,
  booking: { checkIn: Date; checkOut: Date },
): boolean {
  const stored = storedLockedPeriodRequestSchema.safeParse(requestedChanges);
  return stored.success && lockedPeriodRequestToBatchInput(stored.data, booking) === null;
}

/**
 * #4533: what the officer's card needs to know about a stored request's promo
 * change, read through the executor's own schema and mapping: whether the
 * request could take an officer's promo entry (it is readable and carries
 * none), and the promo change it carries, with whether that is its one change
 * (the only shape whose email the officer may withhold).
 */
export function storedRequestPromoFacts(
  requestedChanges: unknown,
  booking: { checkIn: Date; checkOut: Date },
): { takesPromoEntry: boolean; promoCorrection: { codes: string[]; onlyChange: boolean } | null } {
  const stored = storedLockedPeriodRequestSchema.safeParse(requestedChanges);
  if (!stored.success) return { takesPromoEntry: false, promoCorrection: null };
  const promoChange = stored.data.requested.promoChange;
  return {
    takesPromoEntry: !promoChange,
    promoCorrection: promoChange
      ? {
          codes: promoChangeCodes(promoChange),
          onlyChange: storedRequestNamesOnlyPromoChange(stored.data, booking),
        }
      : null,
  };
}

/** One guest's nights as a request asks for them, for the officer's card (#4088). */
export interface RequestedGuestNights {
  name: string;
  /** Runs of consecutive nights, first and last night inclusive; empty for the whole stay. */
  runs: Array<{ firstNight: string; lastNight: string }>;
  /** How many nights the runs hold; `null` for the whole stay. */
  nightCount: number | null;
  /** The guest is one the request adds, not one already on the booking. */
  added: boolean;
  /** An existing guest whose requested nights are the ones they already hold. */
  unchanged: boolean;
  /**
   * An existing guest with gaps in their stay whose request MOVES their Date In
   * or Date Out (a range rather than a night set): approving writes every night
   * of that range, so the gaps inside it are filled (and charged). On a pending
   * request, a range that only repeats their own dates keeps their nights
   * (#4157) and is `unchanged`; see `describeRequestedGuestNights` for how a
   * decided request reads.
   */
  fillsGaps: boolean;
}

type StoredNights = { stayStart?: string | null; stayEnd?: string | null; nights?: string[] | null };

/** A grid night set as runs; else the two bounds as one run, never expanded. */
function requestedRuns(
  entry: StoredNights,
): Pick<RequestedGuestNights, "runs" | "nightCount"> | null {
  if (entry.nights?.length) {
    const runs = collapseNightRuns(entry.nights);
    return {
      runs: runs.map(({ firstNight, lastNight }) => ({ firstNight, lastNight })),
      nightCount: runs.reduce((sum, run) => sum + run.nights.length, 0),
    };
  }
  const stayStart = entry.stayStart ? parseCalendarDate(entry.stayStart) : null;
  const stayEnd = entry.stayEnd ? parseCalendarDate(entry.stayEnd) : null;
  if (!stayStart || !stayEnd) return null;
  return {
    runs: [{ firstNight: stayStart, lastNight: addCalendarDays(stayEnd, -1) }],
    nightCount: countClubNights(stayStart, stayEnd),
  };
}

/**
 * Whether a two-bound range covers a night inside the guest's stored stay that
 * the guest does not hold. Walks only the STORED envelope, never the member's.
 * A range repeating the guest's own dates fills nothing: approval keeps the
 * nights they hold (#4157, `nightsKeptByRepeatedRange`).
 */
function rangeFillsGaps(range: StoredNights, current: GuestNightsAsDays | undefined): boolean {
  if (range.nights?.length || !range.stayStart || !range.stayEnd || !current?.nights?.length) return false;
  if (nightsKeptByRepeatedRange(range, current)) return false;
  const held = new Set(guestNightKeys(current));
  const { stayStart, stayEnd } = range;
  return guestNightKeys({ stayStart: current.stayStart, stayEnd: current.stayEnd }).some(
    (night) => !held.has(night) && night >= stayStart && night < stayEnd,
  );
}

/**
 * Each guest's requested nights, read from the stored request by the
 * executor's own schema, so the officer's card shows the nights approving
 * would apply (#4088): a grid night set as chosen, the nights a guest
 * already holds where their range only repeats their own dates (#4157), else
 * Date In to the last night. Guests the request does not name are not listed;
 * an unreadable row lists nobody.
 *
 * How a repeated range on a gapped guest reads depends on `context.status`
 * (`INV-REQ-012`):
 *
 *  - pending (`REQUESTED`): as approval will apply it, against
 *    `context.guests` — the booking's live rows, the source approval reads
 *    (`keptNightsSource`) — else the snapshot: the kept nights, "no change";
 *  - approved with the approval's `keptNights` record (applying or
 *    acknowledging): exactly as recorded, the kept nights, "no change";
 *  - approved without that record (before this release, or an unreadable
 *    row): listed as asked with neither mark, since an approval before this
 *    release filled the gaps, or only acknowledged the request. Such a row says "no change" at all
 *    only where its snapshot holds the guest's night rows;
 *  - declined: nothing was applied, so as a pending request reads, against the
 *    snapshot. Live rows are never read for a decided request: a decision may
 *    itself have changed them.
 */
export function describeRequestedGuestNights(
  requestedChanges: unknown,
  context: { status: string; guests?: ReadonlyArray<LiveRequestGuestRow> },
): RequestedGuestNights[] {
  const parsed = storedLockedPeriodRequestSchema.safeParse(requestedChanges);
  if (!parsed.success) return [];
  const { original, requested, keptNights } = parsed.data;
  const pending = context.status === "REQUESTED";
  const approved = context.status === "APPROVED";
  const record = approved && keptNights ? new Map(keptNights.map((entry) => [entry.guestId, entry.nights])) : null;
  const approvedUnrecorded = approved && !keptNights;
  // One line per guest, for the entry approval applies (the last one for that
  // guest), so the card never describes an entry the planner ignores (#4157).
  const existing = [...effectiveStayRangeByGuest(appliedRanges(parsed.data)).values()].flatMap((range) => {
    const guest = original.guests.find((candidate) => candidate.id === range.guestId);
    const snapshot =
      guest?.stayStart && guest.stayEnd
        ? { stayStart: guest.stayStart, stayEnd: guest.stayEnd, nights: guest.nights }
        : undefined;
    const current = pending ? keptNightsSource(range.guestId, context.guests, snapshot) : snapshot;
    // Non-null exactly where the outcome depends on #4157's rule.
    const repeatsGapped = nightsKeptByRepeatedRange(range, current);
    const kept = record ? (record.get(range.guestId) ?? null) : approvedUnrecorded ? null : repeatsGapped;
    const nights = requestedRuns(kept ? { nights: kept } : range);
    if (!nights) return [];
    const fillsGaps = !kept && rangeFillsGaps(range, current);
    const unchanged = kept
      ? true
      : Boolean(current) &&
        !fillsGaps &&
        !repeatsGapped &&
        !isEffectiveStayRangeChange(range, current) &&
        (!approvedUnrecorded || Boolean(current?.nights?.length));
    const name = (guest && guestName(guest)) || "A guest on the booking";
    return [{ name, ...nights, added: false, unchanged, fillsGaps }];
  });
  const added = requested.addGuests.map((guest) => ({
    name: guestName(guest),
    ...(requestedRuns(guest) ?? { runs: [], nightCount: null }),
    added: true,
    unchanged: false,
    fillsGaps: false,
  }));
  return [...existing, ...added];
}
