/**
 * Read-only audit of booking edits made AFTER CHECK-IN, before the #2743 and
 * #2744 fixes reached this install (#5242, `INV-MOD-025`).
 *
 * Before PRs #2757 (#2743) and #2758 (#2744) an edit to a stay under way could
 * price wrongly in two ways:
 *
 * - #2743: a guest whose nights had already ended was put back on the booking
 *   by the edit and billed for the booking's remaining nights.
 * - #2744: nights the edit gave back were credited at TODAY's season rate,
 *   not the rate the member paid.
 *
 * Both are fixed going forward and old bookings were left as they were. This
 * LISTS the old edits that may carry either error, so the owner can decide
 * with the evidence in front of them.
 *
 * WHAT THE HISTORY HOLDS, AND WHY IT CANNOT BE EXACT. Before the fixes a
 * mid-stay edit went through the batch edit service, which wrote ONE
 * `BookingModification` per edit: the booking's dates and price totals before
 * and after, and the NAMES of guests removed and added. No per-guest before and
 * after, and every guest's night rows were rewritten. So a price rise with
 * nothing bought, or an add-only edit, can be judged; an extension, a mixed
 * edit or a booking edited again later can only be bounded ("possible, up
 * to"); and a give-back on a party of two or more may hide a re-billed guest
 * inside its credit, an amount nothing records. An officer's date override
 * (`pricingMode: "recalculate"`, through the batch service or the date-change
 * service) re-priced the stay outside the mid-stay rules: a date change put
 * every guest on the full new dates (#1093), one whose nights had ended
 * included, and nights with no stored price took the rates of the day (#1036
 * kept the rest). So every one made mid-stay is listed for a person.
 *
 * A name edit (`GUEST_UPDATE`) is examined too: until #1099 (4 Jul 2026) it ran
 * the same pricing, so one saved mid-stay could re-bill an ended guest; since
 * then it echoes the stored price and reads as clear. Not examined: shift-mode
 * overrides (`ADMIN_DATE_SHIFT`), which moved no money; a paid booking's
 * spelling fix (`GUEST_TYPO_FIX`, #1386), which began after #1099 and has
 * always echoed the price; a guest-to-member link (`GUEST_MEMBER_LINK`), refused
 * beside any other change because it applies only to quote-priced whole-lodge
 * bookings; and `GUEST_ADD` and `GUEST_REMOVE`, whose services refused a stay
 * under way.
 *
 * WHICH EDITS. Edits created before the cut-off - when this install took the
 * fixes - whose club calendar day falls within the stay before the edit,
 * check-in and check-out days included. The cut-off is the finish of the first
 * migration merged after both fixes, plus 24 hours, unless the operator sets it.
 * That migration is NOT on the never-squash list: on an install where it has
 * no record the audit refuses to guess and asks for `--before`.
 *
 * REPORT ONLY - IT NEVER WRITES AND NEVER REPAIRS. Typed SELECTs through Prisma
 * (`INV-OPS-001`) plus the one shared migration-history read, in ONE read-only
 * snapshot (`withReadOnlySnapshot`). It reads the stored snapshots, which hold
 * guest names, but takes only dates, amounts and counts out of them; what it
 * returns and prints is ids and amounts, never a name or email.
 */
import type { Prisma } from "@prisma/client";
import { z } from "zod";

import {
  type CalendarDate,
  type ClubTimeZone,
  calendarDateOfDateOnlyInstant,
  clubCalendarDateOf,
  compareCalendarDates,
  parseCalendarDate,
} from "@/lib/club-time";
import { bookingOwner } from "@/lib/booking-owner";
import { readMigrationFinishedAt } from "@/lib/migration-finished-at";
import { prisma } from "@/lib/prisma";
import { withReadOnlySnapshot } from "@/lib/read-only-snapshot";

/** The first migration merged after both fixes: its finish dates this install's upgrade. */
export const MID_STAY_FIX_MARKER_MIGRATION = "20260810020000_backfill_bed_allocation_audit_category";
/** When the fixes merged on main, printed beside the cut-off so the operator can compare. */
export const FIX_2743_MERGED_AT = "2026-08-10T05:27:29Z"; // PR #2757
export const FIX_2744_MERGED_AT = "2026-08-10T07:11:41Z"; // PR #2758
/** The migration ran during the deploy that carried the fixes; a day's grace errs towards listing more. */
const CUT_OFF_GRACE_MS = 24 * 60 * 60 * 1000;
/** How far a guest row's creation may sit from the edit that added it. */
const ADDED_GUEST_MATCH_MS = 60 * 1000;

/**
 * The row types an edit that could re-price a stay under way wrote; the header
 * says why each other type is left out. `GUEST_UPDATE` is here for the name
 * edits made before #1099, which still ran the pricing.
 */
export const EXAMINED_MODIFICATION_TYPES = ["BATCH_MODIFY", "CREDIT_ELECTION", "DATE_CHANGE", "GUEST_UPDATE"] as const;

export type MidStayEditShape =
  | "officer-recalculated"
  | "rebilled-nothing-bought"
  | "added-guests-excess"
  | "added-guests-unmatched"
  | "extended-or-mixed"
  | "give-back-may-hide-rebill"
  | "give-back-repriced"
  | "unreadable";

/**
 * Each shape's fixed reading. `amount`: what its figure is - the error itself,
 * an upper limit ("up to", not a finding of that much), or an officer
 * re-price's net change, which bounds nothing because nights may have moved
 * both ways. `null` issue: not attributable to either fix alone.
 */
export const MID_STAY_EDIT_SHAPES: Record<
  MidStayEditShape,
  {
    issue: "#2743" | "#2744" | null;
    certainty: "certain" | "possible" | "unreadable";
    amount: "exact" | "up to" | "net change";
    label: string;
  }
> = {
  "officer-recalculated": {
    issue: null,
    certainty: "possible",
    amount: "net change",
    label: "Officer override re-priced the stay",
  },
  "rebilled-nothing-bought": {
    issue: "#2743",
    certainty: "certain",
    amount: "exact",
    label: "Price rose though the edit bought nothing",
  },
  "added-guests-excess": {
    issue: "#2743",
    certainty: "certain",
    amount: "exact",
    label: "Guests added; charged more than the added guests' price",
  },
  "added-guests-unmatched": {
    issue: "#2743",
    certainty: "possible",
    amount: "up to",
    label: "Guests added; their price could not be matched",
  },
  "extended-or-mixed": {
    issue: "#2743",
    certainty: "possible",
    amount: "up to",
    label: "Stay extended, or nights both bought and given back",
  },
  "give-back-may-hide-rebill": {
    issue: "#2743",
    certainty: "possible",
    amount: "exact",
    label: "Nights given back; an ended guest's re-bill may hide in the credit",
  },
  "give-back-repriced": {
    issue: "#2744",
    certainty: "possible",
    amount: "up to",
    label: "Nights given back where today's rate may differ from the rate paid",
  },
  unreadable: {
    issue: null,
    certainty: "unreadable",
    amount: "exact",
    label: "History unreadable - a person checks",
  },
};

export const MID_STAY_EDIT_SHAPE_ORDER = Object.keys(MID_STAY_EDIT_SHAPES) as MidStayEditShape[];

export interface MidStayEditFinding {
  shape: MidStayEditShape;
  /** Cents at stake; `null` when the history cannot say (hidden inside a net credit). */
  atStakeCents: number | null;
  reason: string;
}

const NAMES = z.array(z.unknown());
const SNAPSHOT_DATES = z.object({ checkIn: z.string(), checkOut: z.string() });
const PREVIOUS_SNAPSHOT = SNAPSHOT_DATES.extend({
  totalPriceCents: z.number().int(),
  discountCents: z.number().int().nullish(),
  promoAdjustmentCents: z.number().int().nullish(),
  guestCount: z.number().int().nullish(),
  removedGuests: NAMES.nullish(),
});
const NEW_SNAPSHOT = SNAPSHOT_DATES.extend({
  totalPriceCents: z.number().int(),
  addedGuests: NAMES.nullish(),
  adminOverride: z.boolean().nullish(),
  pricingMode: z.string().nullish(),
});

/** One parsed edit, with what the classifier needs from around it. */
export interface MidStayEditFacts {
  previous: {
    checkIn: CalendarDate;
    checkOut: CalendarDate;
    totalPriceCents: number;
    discountCents: number;
    promoAdjustmentCents: number;
    /** Guests before the edit; `null` when the row did not store it. */
    guestCount: number | null;
    removedGuestCount: number;
  };
  next: {
    checkIn: CalendarDate;
    checkOut: CalendarDate;
    totalPriceCents: number;
    addedGuestCount: number;
    adminOverride: boolean;
    pricingMode: string | null;
  };
  /** An earlier mid-stay edit on this booking removed a guest. */
  earlierMidStayRemoval: boolean;
  /** A season or season rate for the stay's lodge and nights changed after the booking was made. */
  ratesChangedSinceBooking: boolean;
  /** A guest or night price on the booking is now below zero. */
  negativePriceOnBooking: boolean;
  /**
   * The summed price of the guests this edit created, or `null` when they
   * cannot be matched (count differs, or a later edit may have re-priced them).
   */
  addedGuestsPriceCents: number | null;
}

/** An officer override re-priced the stay: the batch service flags it; the date-change service only names the mode. */
export function isOfficerRecalculate(next: Pick<MidStayEditFacts["next"], "adminOverride" | "pricingMode">): boolean {
  if (next.pricingMode === "shift") return false;
  return next.adminOverride || next.pricingMode === "recalculate";
}

/** The findings for one readable mid-stay edit; empty means clear. */
export function classifyMidStayEdit(facts: MidStayEditFacts): MidStayEditFinding[] {
  const { previous, next } = facts;
  const d = next.totalPriceCents - previous.totalPriceCents;

  if (isOfficerRecalculate(next)) {
    // Rates may have moved both ways, so a $0 net change is listed too.
    return [
      {
        shape: "officer-recalculated",
        atStakeCents: Math.abs(d),
        reason:
          "An officer override re-priced the stay: a date change put every guest on the full new dates, and nights with no stored price took the rates of the day. Compare with what the member booked.",
      },
    ];
  }

  const checkOutMove = compareCalendarDates(next.checkOut, previous.checkOut);
  const checkInMove = compareCalendarDates(next.checkIn, previous.checkIn);
  const bought = checkOutMove > 0 || checkInMove < 0 || next.addedGuestCount > 0;
  const gaveBack = checkOutMove < 0 || checkInMove > 0 || previous.removedGuestCount > 0;
  const addOnly = next.addedGuestCount > 0 && checkOutMove === 0 && checkInMove === 0 && previous.removedGuestCount === 0;
  const findings: MidStayEditFinding[] = [];

  if (!bought && d > 0) {
    findings.push({
      shape: "rebilled-nothing-bought",
      atStakeCents: d,
      // A give-back's credit is netted off the rise, so the rise is then a floor.
      reason: `The price rose though the edit added no nights or guests: a guest whose stay had ended was billed again${gaveBack ? ", for at least this much, since the edit also gave nights back" : ""}.`,
    });
  } else if (addOnly && d > 0) {
    if (facts.addedGuestsPriceCents === null) {
      findings.push({
        shape: "added-guests-unmatched",
        atStakeCents: d,
        reason: "Guests were added, but the guests this edit created cannot be matched to the history, so the whole rise is the limit.",
      });
    } else if (d > facts.addedGuestsPriceCents) {
      findings.push({
        shape: "added-guests-excess",
        atStakeCents: d - facts.addedGuestsPriceCents,
        reason: "The price rose by more than the added guests cost: the rest re-billed a guest whose stay had ended.",
      });
    }
  } else if (bought && d > 0) {
    findings.push({
      shape: "extended-or-mixed",
      atStakeCents: d,
      reason: "The edit bought nights, so how much of the rise re-billed an ended guest cannot be told from the history.",
    });
  }

  // #2743 re-admitted a guest whose stay had ended on ANY edit, a shortening
  // included, and the edit rewrote every guest's nights, so nothing left says
  // whether one had. With one guest none can have ended while the stay runs.
  const anotherGuestMayHaveEnded = previous.guestCount === null || previous.guestCount >= 2;
  if (gaveBack && d <= 0 && (facts.earlierMidStayRemoval || anotherGuestMayHaveEnded)) {
    findings.push({
      shape: "give-back-may-hide-rebill",
      atStakeCents: null,
      reason: facts.earlierMidStayRemoval
        ? "An earlier mid-stay edit removed a guest; this one may have billed them again inside its net credit."
        : "A guest whose stay had already ended would have been billed again inside this net credit; the history cannot say whether one had.",
    });
  }

  const repricedBecause = [
    facts.ratesChangedSinceBooking ? "season rates changed after booking" : null,
    previous.discountCents !== 0 || previous.promoAdjustmentCents !== 0 ? "the booking carried a discount or promo" : null,
    facts.negativePriceOnBooking ? "a guest or night price is below zero" : null,
  ].filter((part): part is string => part !== null);
  if (gaveBack && repricedBecause.length > 0) {
    findings.push({
      shape: "give-back-repriced",
      atStakeCents: d < 0 ? -d : null,
      reason: `Nights given back were valued at the rates of the day and ${repricedBecause.join(", and ")}.`,
    });
  }
  return findings;
}

export interface MidStayEditCutOff {
  instant: Date;
  source: "migration" | "operator";
  /** `null` with no history table, or no record of the marker migration. */
  markerFinishedAt: Date | null;
  migrationHistory: boolean;
}

export interface ExaminedMidStayEdit {
  modificationId: string;
  modificationType: string;
  bookingId: string;
  /** The booking's member: the person a remedy would reach; `null` on an organisation's booking. Never a name. */
  memberId: string | null;
  createdAt: Date;
  /** The edit's club calendar day; `null` when unreadable. */
  editedOn: CalendarDate | null;
  priceChangeCents: number | null;
  findings: MidStayEditFinding[];
}

export interface MidStayEditAuditResult {
  cutOff: MidStayEditCutOff;
  /** Every mid-stay edit before the cut-off, clear ones included, and every unreadable one. */
  examined: ExaminedMidStayEdit[];
  /** Mid-stay edits at or after the cut-off: made under the fixes, not examined. */
  midStayAfterCutOff: number;
}

export class MidStayEditCutOffUnknownError extends Error {
  constructor(detail: string) {
    super(
      `${detail} so this install's upgrade time is unknown. Re-run with --before <ISO instant>, the moment this install began running the #2743 and #2744 fixes.`,
    );
    this.name = "MidStayEditCutOffUnknownError";
  }
}

type ModificationRow = {
  id: string;
  bookingId: string;
  modificationType: string;
  previousData: Prisma.JsonValue;
  newData: Prisma.JsonValue;
  createdAt: Date;
};

type Parsed =
  | { readable: true; previous: z.infer<typeof PREVIOUS_SNAPSHOT>; next: z.infer<typeof NEW_SNAPSHOT>; checkIn: CalendarDate; checkOut: CalendarDate; nextCheckIn: CalendarDate; nextCheckOut: CalendarDate }
  | { readable: false; checkIn: CalendarDate | null; checkOut: CalendarDate | null };

function parseModification(row: ModificationRow): Parsed {
  const dates = SNAPSHOT_DATES.safeParse(row.previousData);
  const checkIn = dates.success ? parseCalendarDate(dates.data.checkIn) : null;
  const checkOut = dates.success ? parseCalendarDate(dates.data.checkOut) : null;
  const previous = PREVIOUS_SNAPSHOT.safeParse(row.previousData);
  const next = NEW_SNAPSHOT.safeParse(row.newData);
  const nextCheckIn = next.success ? parseCalendarDate(next.data.checkIn) : null;
  const nextCheckOut = next.success ? parseCalendarDate(next.data.checkOut) : null;
  if (!previous.success || !next.success || !checkIn || !checkOut || !nextCheckIn || !nextCheckOut) {
    return { readable: false, checkIn, checkOut };
  }
  return { readable: true, previous: previous.data, next: next.data, checkIn, checkOut, nextCheckIn, nextCheckOut };
}

function withinStay(day: CalendarDate, checkIn: CalendarDate, checkOut: CalendarDate): boolean {
  return compareCalendarDates(day, checkIn) >= 0 && compareCalendarDates(day, checkOut) <= 0;
}

const ID_CHUNK = 1000;
function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += ID_CHUNK) out.push(items.slice(i, i + ID_CHUNK));
  return out;
}

export async function auditMidStayEditHistory(options: {
  zone: ClubTimeZone;
  /** The operator's cut-off (`--before`); absent derives it from the marker migration. */
  before?: Date;
  db?: typeof prisma;
}): Promise<MidStayEditAuditResult> {
  // A whole-table read: give it room, and fail rather than queue forever.
  return withReadOnlySnapshot(options.db ?? prisma, (tx) => auditInSnapshot(tx, options), {
    maxWait: 10_000,
    timeout: 120_000,
  });
}

async function readCutOff(db: Prisma.TransactionClient, before: Date | undefined): Promise<MidStayEditCutOff> {
  const marker = await readMigrationFinishedAt(db, MID_STAY_FIX_MARKER_MIGRATION);
  const markerFinishedAt =
    marker.history && marker.finishedAtSeconds !== null ? new Date(marker.finishedAtSeconds * 1000) : null;
  if (before) {
    return { instant: before, source: "operator", markerFinishedAt, migrationHistory: marker.history };
  }
  if (!marker.history) throw new MidStayEditCutOffUnknownError("This database has no migration history,");
  if (!markerFinishedAt) {
    throw new MidStayEditCutOffUnknownError(`Migration ${MID_STAY_FIX_MARKER_MIGRATION} has no finish recorded here,`);
  }
  return {
    instant: new Date(markerFinishedAt.getTime() + CUT_OFF_GRACE_MS),
    source: "migration",
    markerFinishedAt,
    migrationHistory: true,
  };
}

async function auditInSnapshot(
  db: Prisma.TransactionClient,
  options: { zone: ClubTimeZone; before?: Date },
): Promise<MidStayEditAuditResult> {
  const cutOff = await readCutOff(db, options.before);

  const modifications: ModificationRow[] = await db.bookingModification.findMany({
    where: { modificationType: { in: [...EXAMINED_MODIFICATION_TYPES] } },
    select: { id: true, bookingId: true, modificationType: true, previousData: true, newData: true, createdAt: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });

  type Candidate = { row: ModificationRow; parsed: Parsed; editedOn: CalendarDate };
  const candidates: Candidate[] = [];
  let midStayAfterCutOff = 0;
  for (const row of modifications) {
    const parsed = parseModification(row);
    if (parsed.readable && parsed.next.pricingMode === "shift") continue;
    const editedOn = clubCalendarDateOf(row.createdAt, options.zone);
    const midStay = parsed.checkIn && parsed.checkOut ? withinStay(editedOn, parsed.checkIn, parsed.checkOut) : null;
    if (row.createdAt.getTime() >= cutOff.instant.getTime()) {
      if (midStay) midStayAfterCutOff += 1;
      continue;
    }
    // Unreadable dates cannot be placed against the stay: listed, never dropped.
    if (midStay === false) continue;
    candidates.push({ row, parsed, editedOn });
  }

  const bookingIds = [...new Set(candidates.map((candidate) => candidate.row.bookingId))];
  const bookings = new Map<string, { memberId: string | null; lodgeId: string; createdAt: Date }>();
  const guestsByBooking = new Map<string, { createdAt: Date; priceCents: number; minNightPriceCents: number | null }[]>();
  const lastEditByBooking = new Map<string, Date>();
  for (const ids of chunks(bookingIds)) {
    for (const booking of await db.booking.findMany({
      where: { id: { in: ids } },
      select: { id: true, memberId: true, lodgeId: true, createdAt: true },
    })) {
      bookings.set(booking.id, booking);
    }
    for (const guest of await db.bookingGuest.findMany({
      where: { bookingId: { in: ids } },
      select: { bookingId: true, createdAt: true, priceCents: true, nights: { select: { priceCents: true } } },
    })) {
      const nightPrices = guest.nights.map((night) => night.priceCents).filter((cents): cents is number => cents !== null);
      const list = guestsByBooking.get(guest.bookingId) ?? [];
      list.push({
        createdAt: guest.createdAt,
        priceCents: guest.priceCents,
        minNightPriceCents: nightPrices.length > 0 ? Math.min(...nightPrices) : null,
      });
      guestsByBooking.set(guest.bookingId, list);
    }
    // Any later edit of any type may have re-priced the guests an edit added.
    for (const group of await db.bookingModification.groupBy({
      by: ["bookingId"],
      where: { bookingId: { in: ids } },
      _max: { createdAt: true },
    })) {
      if (group._max.createdAt) lastEditByBooking.set(group.bookingId, group._max.createdAt);
    }
  }

  const seasons = await db.season.findMany({
    select: {
      lodgeId: true,
      startDate: true,
      endDate: true,
      updatedAt: true,
      membershipTypeRates: { select: { updatedAt: true } },
    },
  });
  const ratesChangedSince = (lodgeId: string, checkIn: CalendarDate, checkOut: CalendarDate, since: Date) => {
    const covering = seasons.filter(
      (season) =>
        season.lodgeId === lodgeId &&
        compareCalendarDates(calendarDateOfDateOnlyInstant(season.startDate), checkOut) <= 0 &&
        compareCalendarDates(calendarDateOfDateOnlyInstant(season.endDate), checkIn) >= 0,
    );
    // A deleted season leaves no row: none covering the stay counts as a change.
    if (covering.length === 0) return true;
    // A row's last update hides any earlier one, so any change since booking counts.
    return covering.some(
      (season) =>
        season.updatedAt.getTime() > since.getTime() ||
        season.membershipTypeRates.some((rate) => rate.updatedAt.getTime() > since.getTime()),
    );
  };

  const examined: ExaminedMidStayEdit[] = [];
  // Candidates run oldest first, so this holds the bookings an EARLIER mid-stay edit removed a guest from.
  const bookingsWithMidStayRemoval = new Set<string>();
  for (const { row, parsed, editedOn } of candidates) {
    const booking = bookings.get(row.bookingId);
    const base = {
      modificationId: row.id,
      modificationType: row.modificationType,
      bookingId: row.bookingId,
      memberId: booking ? bookingOwner(booking).memberId : null,
      createdAt: row.createdAt,
    };
    if (!parsed.readable || !booking) {
      examined.push({
        ...base,
        editedOn: parsed.checkIn ? editedOn : null,
        priceChangeCents: null,
        findings: [
          {
            shape: "unreadable",
            atStakeCents: null,
            reason: booking
              ? "The edit's before-and-after record cannot be read; a person checks it."
              : "The edit's booking cannot be read; a person checks it.",
          },
        ],
      });
      continue;
    }
    const removedGuestCount = parsed.previous.removedGuests?.length ?? 0;
    const addedGuestCount = parsed.next.addedGuests?.length ?? 0;
    const earlierMidStayRemoval = bookingsWithMidStayRemoval.has(row.bookingId);
    if (removedGuestCount > 0) bookingsWithMidStayRemoval.add(row.bookingId);

    const guests = guestsByBooking.get(row.bookingId) ?? [];
    const created = guests.filter(
      (guest) => Math.abs(guest.createdAt.getTime() - row.createdAt.getTime()) <= ADDED_GUEST_MATCH_MS,
    );
    const lastEdit = lastEditByBooking.get(row.bookingId);
    const editedLater = lastEdit !== undefined && lastEdit.getTime() > row.createdAt.getTime();
    const addedGuestsPriceCents =
      addedGuestCount > 0 && created.length === addedGuestCount && !editedLater
        ? created.reduce((sum, guest) => sum + guest.priceCents, 0)
        : null;

    const facts: MidStayEditFacts = {
      previous: {
        checkIn: parsed.checkIn,
        checkOut: parsed.checkOut,
        totalPriceCents: parsed.previous.totalPriceCents,
        discountCents: parsed.previous.discountCents ?? 0,
        promoAdjustmentCents: parsed.previous.promoAdjustmentCents ?? 0,
        guestCount: parsed.previous.guestCount ?? null,
        removedGuestCount,
      },
      next: {
        checkIn: parsed.nextCheckIn,
        checkOut: parsed.nextCheckOut,
        totalPriceCents: parsed.next.totalPriceCents,
        addedGuestCount,
        adminOverride: parsed.next.adminOverride === true,
        pricingMode: parsed.next.pricingMode ?? null,
      },
      earlierMidStayRemoval,
      ratesChangedSinceBooking: ratesChangedSince(booking.lodgeId, parsed.checkIn, parsed.checkOut, booking.createdAt),
      negativePriceOnBooking: guests.some(
        (guest) => guest.priceCents < 0 || (guest.minNightPriceCents !== null && guest.minNightPriceCents < 0),
      ),
      addedGuestsPriceCents,
    };
    examined.push({
      ...base,
      editedOn,
      priceChangeCents: facts.next.totalPriceCents - facts.previous.totalPriceCents,
      findings: classifyMidStayEdit(facts),
    });
  }

  return { cutOff, examined, midStayAfterCutOff };
}
