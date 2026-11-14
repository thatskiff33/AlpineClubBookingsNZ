/**
 * The paid-booking import's planner (#5005, child A; `INV-CAP-040`). Read-only:
 * it says what each booking in a parsed file would do — import, or be refused
 * with a plain reason — and the totals, beds per night and digest the officer
 * confirms against. The dry run and the confirm pre-check both call
 * `planBookingImport`; the writer (`write.ts`) repeats every check for one
 * booking under its locks through `checkImportBooking`, so the preview and the
 * writer cannot use different matchers, date readers or capacity arithmetic.
 *
 * A refusal reason names lines, Booking Refs and nights, never a person or
 * another booking (`INV-CAP-015`, `INV-PRIV-011`).
 */
import {
  AgeTier,
  BookingImportRowStatus,
  type Prisma,
} from "@prisma/client";

import { evaluateProposedAdultMemberHosting } from "@/lib/adult-member-hosting-proposed";
import { requiresAdultSupervisionReview } from "@/lib/adult-supervision";
import {
  findBookingMemberNightConflicts,
  lockBookingMemberNights,
} from "@/lib/booking-member-night-conflicts";
import type { ParsedImportBooking } from "@/lib/booking-import/parse";
import { checkCapacityForGuestRanges, getLodgeCapacity } from "@/lib/capacity";
import { formatStayDate, type ClubDateFormat } from "@/lib/club-time";
import { addDaysDateOnly, eachDateOnlyInRange, formatDateOnly, parseDateOnly } from "@/lib/date-only";
import { loadBookingImportLodge, loadBookingImportMembers, resolveImportBooking } from "@/lib/booking-import/resolve";
import { stableDigest } from "@/lib/stable-digest";
import { lodgeNullTolerantScope } from "@/lib/lodges";
import { memberImportIdentityKey } from "@/lib/member-import-identity";
import { priceBookingGuestsWithMembershipTypePolicy } from "@/lib/membership-type-policy";
import {
  toGuestPricingInputs,
  toSeasonRateData,
} from "@/lib/policies/booking-route-decisions";

export type BookingImportDb = Prisma.TransactionClient;

/** What a refusal is about; the refused totals are broken down by it. */
export const BOOKING_IMPORT_REFUSAL_CODES = [
  "UNREADABLE",
  "PART_PAID",
  "LODGE",
  "MEMBER",
  "PAST_CHECK_IN",
  "ALREADY_IMPORTED",
  "PERSON_NIGHT",
  "HOSTING",
  "SUPERVISION",
  "WHOLE_LODGE_HOLD",
  "OVER_CAPACITY",
  /** The writer only: the settlement refused the booking under the locks. */
  "NOT_SETTLED",
] as const;

export type BookingImportRefusalCode = (typeof BOOKING_IMPORT_REFUSAL_CODES)[number];

export type BookingImportRefusal = { code: BookingImportRefusalCode; message: string };

const BOOK_ON_BEHALF = "enter this booking through Book on Behalf";

/** The hosting refusal, written by the planner and, under the locks, the writer. */
export const BOOKING_IMPORT_HOSTING_REFUSAL: BookingImportRefusal = {
  code: "HOSTING",
  message: `Breaks the club's rule that non-members stay with an adult member; ${BOOK_ON_BEHALF}`,
};

export type ResolvedImportGuest = {
  lineNumber: number;
  firstName: string;
  lastName: string;
  ageTier: AgeTier;
  isMember: boolean;
  memberId: string | null;
  stayStart: Date;
  stayEnd: Date;
  priceCents: number;
};

/** A booking whose people are matched to members: what the writer creates. */
export type ResolvedImportBooking = {
  bookingRef: string;
  ownerMemberId: string;
  checkIn: Date;
  checkOut: Date;
  totalCents: number;
  notes: string;
  guests: ResolvedImportGuest[];
};

export type BookingImportLodge = { id: string; name: string; slug: string; active: boolean };

export type BookingImportContext = {
  lodge: BookingImportLodge;
  /** How many lodges are open for bookings; above one, the Lodge column is required. */
  activeLodgeCount: number;
  /** The club's today as a stored date-only instant, resolved before any transaction (`INV-LOCK-004`). */
  today: Date;
  /** The club's date format for refusal text, resolved before any transaction. */
  format: ClubDateFormat;
};

/** Beds and member-nights claimed by the earlier will-import rows of the same file. */
export type BookingImportFileState = {
  guests: Pick<ResolvedImportGuest, "memberId" | "stayStart" | "stayEnd">[];
  bookingRefsByNight: Map<string, string[]>;
  memberNights: Map<string, Map<string, string>>;
};

export function emptyBookingImportFileState(): BookingImportFileState {
  return { guests: [], bookingRefsByNight: new Map(), memberNights: new Map() };
}

function guestNightKeys(guest: Pick<ResolvedImportGuest, "stayStart" | "stayEnd">): string[] {
  return eachDateOnlyInRange(guest.stayStart, guest.stayEnd).map(formatDateOnly);
}

function nightList(keys: readonly string[], format: ClubDateFormat): string {
  return [...keys].sort().map((key) => formatStayDate(parseDateOnly(key), format)).join(", ");
}

export type ImportCapacityNight = {
  night: string;
  /** Beds the booking needs that night. */
  beds: number;
};

/**
 * Every check that reads the database, for one resolved booking, in the order
 * the refusals are listed: past check-in, a Booking Ref already imported, a
 * member already booked that night (in the app or earlier in the file), the
 * hosting rule, adult supervision, an exclusive whole-lodge hold, capacity.
 *
 * `lock` is the writer's mode: it takes the person-night keys before reading
 * them (`INV-LOCK-002`, after the caller's lock(1) and lodge key) and leaves
 * `file` empty, because earlier rows are committed by then.
 */
export async function checkImportBooking(
  db: BookingImportDb,
  context: BookingImportContext,
  booking: ResolvedImportBooking,
  options: {
    file: BookingImportFileState;
    /** Rows of this batch are this batch's own, never "already imported". */
    batchId: string | null;
    lock: boolean;
  },
): Promise<{
  refusals: BookingImportRefusal[];
  nights: ImportCapacityNight[];
  overCapacityNights: string[];
}> {
  const { format } = context;
  const refusals: BookingImportRefusal[] = [];

  if (booking.checkIn < context.today) {
    refusals.push({
      code: "PAST_CHECK_IN",
      message: "Check In is before today at the club; only future stays can be imported",
    });
  }

  const imported = await db.bookingImportRow.findFirst({
    where: {
      lodgeId: context.lodge.id,
      bookingRef: booking.bookingRef,
      status: BookingImportRowStatus.IMPORTED,
      ...(options.batchId ? { batchId: { not: options.batchId } } : {}),
    },
    select: { id: true },
  });
  if (imported) {
    refusals.push({
      code: "ALREADY_IMPORTED",
      message: "This Booking Ref has already been imported into this lodge",
    });
  }

  const conflictGuests = booking.guests.map((guest) => ({
    memberId: guest.memberId,
    stayStart: guest.stayStart,
    stayEnd: guest.stayEnd,
  }));
  if (options.lock) await lockBookingMemberNights(db, conflictGuests);
  const conflicts = await findBookingMemberNightConflicts(db, {
    actorMemberId: null,
    actorRole: "ADMIN",
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
    guests: conflictGuests,
    today: context.today,
  });
  const lineOf = (memberId: string) =>
    booking.guests.find((guest) => guest.memberId === memberId)?.lineNumber;
  for (const conflict of conflicts) {
    refusals.push({
      code: "PERSON_NIGHT",
      message: `The member on line ${lineOf(conflict.memberId)} is already on another booking on ${nightList(conflict.conflictingNights, format)}`,
    });
  }
  for (const guest of booking.guests) {
    if (!guest.memberId) continue;
    const claimed = options.file.memberNights.get(guest.memberId);
    if (!claimed) continue;
    const clash = guestNightKeys(guest).filter((night) => claimed.has(night));
    if (clash.length === 0) continue;
    const refs = [...new Set(clash.map((night) => claimed.get(night)))].join(", ");
    refusals.push({
      code: "PERSON_NIGHT",
      message: `The member on line ${guest.lineNumber} is also on Booking Ref ${refs} in this file on ${nightList(clash, format)}`,
    });
  }

  const hosting = await evaluateProposedAdultMemberHosting(db, {
    bookingOwnerMemberId: booking.ownerMemberId,
    groupBookingId: null,
    lodgeId: context.lodge.id,
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
    guests: booking.guests.map((guest) => ({
      firstName: guest.firstName,
      lastName: guest.lastName,
      memberId: guest.memberId,
      stayStart: guest.stayStart,
      stayEnd: guest.stayEnd,
    })),
  });
  if (hosting) refusals.push(BOOKING_IMPORT_HOSTING_REFUSAL);

  // Every imported guest is present: a member guest is written as an officer
  // assignment (CONFIRMED) or consent-free, never as a pending request.
  if (
    requiresAdultSupervisionReview(
      booking.guests.map((guest) => ({ ageTier: guest.ageTier, consentStatus: null })),
    )
  ) {
    refusals.push({
      code: "SUPERVISION",
      message: `Has children with no adult staying; ${BOOK_ON_BEHALF}`,
    });
  }

  const capacity = await checkCapacityForGuestRanges(
    context.lodge.id,
    booking.checkIn,
    booking.checkOut,
    [...options.file.guests, ...conflictGuests],
    undefined,
    db,
  );
  const held: string[] = [];
  const full: { night: string; people: number; beds: number }[] = [];
  const nights: ImportCapacityNight[] = [];
  for (const detail of capacity.nightDetails) {
    const night = formatDateOnly(detail.date);
    const beds = booking.guests.filter(
      (guest) => guest.stayStart <= detail.date && detail.date < guest.stayEnd,
    ).length;
    // A night inside the booking's span that none of its guests stays (a gap
    // between two guests' stays) is not the booking's: it neither claims a bed
    // nor is refused for that night being full or held. This also keeps the
    // shape the parser's `nightDemand` has, which a resumed plan reports for a
    // row already imported, so resuming cannot move the digest.
    if (beds === 0) continue;
    nights.push({ night, beds });
    if (detail.wholeLodgeHeld) {
      held.push(night);
      continue;
    }
    if (detail.availableBeds < 0) {
      full.push({
        night,
        people: detail.occupiedBeds,
        beds: detail.occupiedBeds + detail.availableBeds,
      });
    }
  }
  if (held.length > 0) {
    refusals.push({
      code: "WHOLE_LODGE_HOLD",
      message: `The whole lodge is held on ${nightList(held, format)}`,
    });
  }
  for (const { night, people, beds } of full) {
    refusals.push({
      code: "OVER_CAPACITY",
      message: `${formatStayDate(parseDateOnly(night), format)} would have ${people} people in a ${beds}-bed lodge`,
    });
  }
  return { refusals, nights, overCapacityNights: full.map(({ night }) => night) };
}

export type BookingImportOutcome = "IMPORT" | "REFUSED";

export type BookingImportRowPlan = {
  bookingRef: string;
  firstLineNumber: number;
  outcome: BookingImportOutcome;
  /** Set when an earlier confirm of this batch already imported the booking. */
  alreadyImported: boolean;
  refusals: BookingImportRefusal[];
  checkIn: string;
  checkOut: string;
  amountCents: number;
  guestCount: number;
  guestNightCount: number;
  /** The typing check: what the app's rates charge today. Null when they cannot price it. */
  appRateCents: number | null;
  /** `amountCents - appRateCents`; never a reason to refuse. */
  appRateDifferenceCents: number | null;
  /** Beds the booking holds each night it stays. */
  nights: ImportCapacityNight[];
  /** The nights it was refused for want of beds. */
  overCapacityNights: string[];
};

export type BookingImportTotals = {
  bookings: number;
  guests: number;
  guestNights: number;
  amountCents: number;
};

export type BookingImportNightRow = {
  night: string;
  capacity: number;
  /** Beds already held in the app, including bookings an earlier confirm of this batch imported. */
  heldBeds: number;
  /** Canonical occupancy after accepted proposals, accounting for custodian overlap. */
  projectedBeds: number;
  importBeds: number;
  /** Beds sold in the old system but refused here, so not held in the app. */
  refusedBeds: number;
  wholeLodgeHeld: boolean;
};

export type BookingImportPlan = {
  lodgeId: string;
  batchKey: string;
  digest: string;
  rows: BookingImportRowPlan[];
  importTotals: BookingImportTotals;
  refusedTotals: BookingImportTotals;
  refusedByCode: Partial<Record<BookingImportRefusalCode, BookingImportTotals>>;
  nights: BookingImportNightRow[];
  /** The over-full nights, each with the bookings that fit and those that did not. */
  overFullNights: { night: string; fitted: string[]; refused: string[] }[];
};

const emptyTotals = (): BookingImportTotals => ({
  bookings: 0,
  guests: 0,
  guestNights: 0,
  amountCents: 0,
});

function addToTotals(totals: BookingImportTotals, row: BookingImportRowPlan) {
  totals.bookings += 1;
  totals.guests += row.guestCount;
  totals.guestNights += row.guestNightCount;
  totals.amountCents += row.amountCents;
}

/**
 * The batch key: the lodge and the file's normalised content. The same file
 * uploaded again finds the same batch and resumes it.
 */
export function bookingImportBatchKey(
  lodgeId: string,
  bookings: readonly ParsedImportBooking[],
): string {
  return stableDigest([
    lodgeId,
    bookings.map((booking) => [
      booking.bookingRef,
      booking.lodge.toLowerCase(),
      memberImportIdentityKey(booking.owner),
      booking.notes,
      booking.checkIn,
      booking.checkOut,
      booking.totalCents,
      booking.refusals,
      booking.nightDemand,
      booking.guests.map((guest) => [
        guest.isMember,
        memberImportIdentityKey(guest.identity),
        guest.ageTier,
        guest.checkIn,
        guest.checkOut,
        guest.amountCents,
      ]),
    ]),
  ]);
}

/** The digest of what the officer was shown: every row's outcome and reasons, and its figures. */
export function bookingImportPlanDigest(
  lodgeId: string,
  rows: readonly BookingImportRowPlan[],
  batchKey: string,
  nights: readonly BookingImportNightRow[],
): string {
  return stableDigest([
    lodgeId,
    batchKey,
    nights.map((night) => [night.night, night.capacity, night.projectedBeds, night.refusedBeds, night.wholeLodgeHeld]),
    rows.map((row) => [
      row.bookingRef,
      row.outcome,
      row.refusals.map((refusal) => refusal.message),
      row.amountCents,
      row.guestCount,
      row.guestNightCount,
      row.checkIn,
      row.checkOut,
      row.appRateCents,
      row.nights,
    ]),
  ]);
}

/** Stored refusal text: one reason per line. */
export const joinBookingImportRefusals = (refusals: readonly BookingImportRefusal[]) =>
  refusals.map((refusal) => refusal.message).join("\n");

function isRefusalCode(value: string | null): value is BookingImportRefusalCode {
  return (BOOKING_IMPORT_REFUSAL_CODES as readonly string[]).includes(value ?? "");
}

/**
 * Reads a stored refusal back: `joinBookingImportRefusals`'s inverse. Only the
 * first reason's code is stored, so every line carries it.
 */
export function splitBookingImportRefusals(
  reason: string | null,
  code: string | null,
): BookingImportRefusal[] {
  const storedCode = isRefusalCode(code) ? code : "UNREADABLE";
  return (reason ?? "")
    .split("\n")
    .filter(Boolean)
    .map((message) => ({ code: storedCode, message }));
}

async function appRateCents(
  db: BookingImportDb,
  booking: ResolvedImportBooking,
  seasons: Parameters<typeof toSeasonRateData>[0],
): Promise<number | null> {
  try {
    const quote = await priceBookingGuestsWithMembershipTypePolicy(db, {
      ownerMemberId: booking.ownerMemberId,
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
      guests: toGuestPricingInputs(booking.guests),
      seasons: toSeasonRateData(seasons),
      skipAuthorization: true,
    });
    return quote.totalPriceCents;
  } catch {
    // A stay the app's rates cannot price (no season, a membership type the
    // policy refuses) has no comparison to show; it is not a reason to refuse.
    return null;
  }
}

/**
 * Plans a parsed file for one lodge. Bookings are checked in file order, each
 * against the beds already held plus the earlier will-import rows. With
 * `batchId`, rows that batch has already decided are reported as decided, so
 * a resumed confirm sees the digest it was shown.
 */
export async function planBookingImport(
  db: BookingImportDb,
  input: {
    lodgeId: string;
    bookings: readonly ParsedImportBooking[];
    today: Date;
    format: ClubDateFormat;
    batchId?: string | null;
  },
): Promise<BookingImportPlan> {
  const batchId = input.batchId ?? null;
  const { lodge, activeLodgeCount } = await loadBookingImportLodge(db, input.lodgeId);
  if (!lodge) throw new Error("The lodge to import into does not exist");
  const context: BookingImportContext = {
    lodge,
    activeLodgeCount,
    today: input.today,
    format: input.format,
  };
  const [members, seasons, decidedRows] = await Promise.all([
    loadBookingImportMembers(db, input.bookings),
    db.season.findMany({
      where: { active: true, ...lodgeNullTolerantScope(lodge.id) },
      include: { membershipTypeRates: true },
    }),
    batchId
      ? db.bookingImportRow.findMany({
          where: { batchId, status: { not: BookingImportRowStatus.PENDING } },
          select: { bookingRef: true, status: true, refusalReason: true, refusalCode: true },
        })
      : Promise.resolve([]),
  ]);
  const decided = new Map(decidedRows.map((row) => [row.bookingRef, row]));

  const file = emptyBookingImportFileState();
  const rows: BookingImportRowPlan[] = [];
  for (const booking of input.bookings) {
    const base = {
      bookingRef: booking.bookingRef,
      firstLineNumber: booking.firstLineNumber,
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
      amountCents: booking.totalCents,
      guestCount: booking.lineCount,
      guestNightCount: booking.guestNightCount,
    };
    const { resolved, refusals } = resolveImportBooking(booking, context, members);

    const prior = decided.get(booking.bookingRef);
    if (prior) {
      const rate = resolved ? await appRateCents(db, resolved, seasons) : null;
      const imported = prior.status === BookingImportRowStatus.IMPORTED;
      rows.push({
        ...base,
        outcome: imported ? "IMPORT" : "REFUSED",
        alreadyImported: imported,
        refusals: imported ? [] : splitBookingImportRefusals(prior.refusalReason, prior.refusalCode),
        appRateCents: rate,
        appRateDifferenceCents: rate === null ? null : booking.totalCents - rate,
        nights: booking.nightDemand,
        overCapacityNights: [],
      });
      continue;
    }

    if (!resolved) {
      rows.push({
        ...base,
        outcome: "REFUSED",
        alreadyImported: false,
        refusals,
        appRateCents: null,
        appRateDifferenceCents: null,
        nights: booking.nightDemand,
        overCapacityNights: [],
      });
      continue;
    }

    const checked = await checkImportBooking(db, context, resolved, { file, batchId, lock: false });
    const rate = await appRateCents(db, resolved, seasons);
    const row: BookingImportRowPlan = {
      ...base,
      outcome: checked.refusals.length === 0 ? "IMPORT" : "REFUSED",
      alreadyImported: false,
      refusals: checked.refusals,
      appRateCents: rate,
      appRateDifferenceCents: rate === null ? null : booking.totalCents - rate,
      nights: checked.nights,
      overCapacityNights: checked.overCapacityNights,
    };
    rows.push(row);
    if (row.outcome === "IMPORT") {
      file.guests.push(...resolved.guests);
      for (const { night } of checked.nights) {
        file.bookingRefsByNight.set(night, [
          ...(file.bookingRefsByNight.get(night) ?? []),
          booking.bookingRef,
        ]);
      }
      for (const guest of resolved.guests) {
        if (!guest.memberId) continue;
        const claimed = file.memberNights.get(guest.memberId) ?? new Map<string, string>();
        for (const night of guestNightKeys(guest)) claimed.set(night, booking.bookingRef);
        file.memberNights.set(guest.memberId, claimed);
      }
    }
  }

  const importTotals = emptyTotals();
  const refusedTotals = emptyTotals();
  const refusedByCode: BookingImportPlan["refusedByCode"] = {};
  for (const row of rows) {
    if (row.outcome === "IMPORT") {
      addToTotals(importTotals, row);
      continue;
    }
    addToTotals(refusedTotals, row);
    const code = row.refusals[0]?.code ?? "UNREADABLE";
    const byCode = refusedByCode[code] ?? emptyTotals();
    addToTotals(byCode, row);
    refusedByCode[code] = byCode;
  }

  const batchKey = bookingImportBatchKey(lodge.id, input.bookings);
  const nights = await nightTable(db, lodge.id, rows, file.guests);
  return {
    lodgeId: lodge.id,
    batchKey,
    digest: bookingImportPlanDigest(lodge.id, rows, batchKey, nights),
    rows,
    importTotals,
    refusedTotals,
    refusedByCode,
    nights,
    overFullNights: overFullNights(rows, file),
  };
}

async function nightTable(
  db: BookingImportDb,
  lodgeId: string,
  rows: readonly BookingImportRowPlan[],
  proposed: BookingImportFileState["guests"],
): Promise<BookingImportNightRow[]> {
  const stayed = rows.flatMap((row) => row.nights.map(({ night }) => night)).sort();
  const first = stayed[0];
  const last = stayed.at(-1);
  if (!first || !last) return [];
  const capacity = await getLodgeCapacity(lodgeId, db);
  // Query only adjacent sold nights: a mistyped year in a refused row must
  // never expand the empty years between two otherwise valid stays.
  const ranges: { start: Date; end: Date }[] = [];
  for (const key of [...new Set(stayed)]) {
    const date = parseDateOnly(key);
    const lastRange = ranges.at(-1);
    if (lastRange?.end.getTime() === date.getTime()) {
      lastRange.end = addDaysDateOnly(date, 1);
    } else {
      ranges.push({ start: date, end: addDaysDateOnly(date, 1) });
    }
  }
  const details = [];
  const projectedByNight = new Map<string, number>();
  for (const range of ranges) {
    const held = await checkCapacityForGuestRanges(lodgeId, range.start, range.end, [], undefined, db);
    details.push(...held.nightDetails);
    const projected = await checkCapacityForGuestRanges(lodgeId, range.start, range.end, proposed, undefined, db);
    for (const night of projected.nightDetails) projectedByNight.set(formatDateOnly(night.date), night.occupiedBeds);
  }
  const bedsOn = (night: string, keep: (row: BookingImportRowPlan) => boolean) =>
    rows
      .filter(keep)
      .reduce((sum, row) => sum + (row.nights.find((entry) => entry.night === night)?.beds ?? 0), 0);
  return details.map((detail) => {
    const night = formatDateOnly(detail.date);
    return {
      night,
      capacity,
      heldBeds: detail.occupiedBeds,
      projectedBeds: projectedByNight.get(night) ?? detail.occupiedBeds,
      importBeds: bedsOn(night, (row) => row.outcome === "IMPORT" && !row.alreadyImported),
      refusedBeds: bedsOn(night, (row) => row.outcome === "REFUSED"),
      wholeLodgeHeld: detail.wholeLodgeHeld,
    };
  });
}

function overFullNights(
  rows: readonly BookingImportRowPlan[],
  file: BookingImportFileState,
): BookingImportPlan["overFullNights"] {
  const refusedByNight = new Map<string, string[]>();
  for (const row of rows) {
    for (const night of row.overCapacityNights) {
      refusedByNight.set(night, [...(refusedByNight.get(night) ?? []), row.bookingRef]);
    }
  }
  return [...refusedByNight]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([night, refused]) => ({
      night,
      fitted: file.bookingRefsByNight.get(night) ?? [],
      refused,
    }));
}
