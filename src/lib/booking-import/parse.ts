/**
 * The paid-booking import's file reader (#5005, child A). Pure: text in,
 * bookings out, no database.
 *
 * One CSV row per guest; rows sharing a Booking Ref are one booking. Dates are
 * club calendar dates read by the member import's normaliser in the format the
 * officer picks, amounts are dollars and cents read by
 * `parseDecimalDollarsToCents`, and members are named by the member import's
 * identity key (`INV-SSOT`). Nothing here decides whether a booking imports —
 * a booking that cannot be read carries its reasons in `refusals` and the
 * planner (`plan.ts`) refuses it with them.
 */
import { AgeTier } from "@prisma/client";

import { countNightsDateOnly, eachDateOnlyInRange, formatDateOnly, parseDateOnly } from "@/lib/date-only";
import { allocateCentsEvenly } from "@/lib/finance-booking-metric-calculations";
import {
  DEFAULT_MEMBER_IMPORT_DATE_FORMAT,
  MEMBER_IMPORT_MAX_ROWS,
  normalizeMemberImportDateValue,
  parseMemberImportCsv,
  type MemberImportDateFormat,
} from "@/lib/member-csv-import";
import { MAX_INTEGER_CENTS, parseDecimalDollarsToCents } from "@/lib/money-input";

/** The longest stay a row may describe. A guard against a mistyped year. */
export const BOOKING_IMPORT_MAX_NIGHTS = 366;

/** The refusal every booking with a balance owing gets until #5008 ships. */
export const BOOKING_IMPORT_PART_PAID_REFUSAL =
  "part-paid bookings cannot be imported yet";

export const BOOKING_IMPORT_COLUMNS = [
  { key: "bookingRef", label: "Booking Ref", required: true },
  { key: "lodge", label: "Lodge", required: false },
  { key: "ownerEmail", label: "Owner Email", required: true },
  { key: "ownerFirstName", label: "Owner First Name", required: true },
  { key: "ownerLastName", label: "Owner Last Name", required: true },
  { key: "guestType", label: "Guest Type", required: true },
  { key: "guestEmail", label: "Guest Email", required: true },
  { key: "guestFirstName", label: "Guest First Name", required: true },
  { key: "guestLastName", label: "Guest Last Name", required: true },
  { key: "ageGroup", label: "Age Group", required: true },
  { key: "checkIn", label: "Check In", required: true },
  { key: "checkOut", label: "Check Out", required: true },
  { key: "amountPaid", label: "Amount Paid", required: true },
  { key: "nights", label: "Nights", required: false },
  { key: "notes", label: "Notes", required: false },
  { key: "balanceOwing", label: "Balance Owing", required: false },
  { key: "balanceDueDate", label: "Balance Due Date", required: false },
] as const;

export type BookingImportColumnKey =
  (typeof BOOKING_IMPORT_COLUMNS)[number]["key"];

export type BookingImportPersonName = {
  email: string;
  firstName: string;
  lastName: string;
};

export type BookingImportGuest = {
  lineNumber: number;
  isMember: boolean;
  /** Email is matched for member guests only; a non-member's is ignored. */
  identity: BookingImportPersonName;
  /** Read from the Age Group column for non-members; a member's comes from their record. */
  ageTier: AgeTier | null;
  /** `YYYY-MM-DD` club calendar dates; Check Out is the departure morning. */
  checkIn: string;
  checkOut: string;
  nights: number;
  /** This guest's share of what was paid, in integer cents. */
  amountCents: number;
};

export type BookingImportAmountMode = "PER_GUEST" | "BOOKING_TOTAL";

export type BookingImportNightDemand = { night: string; beds: number };

export type ParsedImportBooking = {
  bookingRef: string;
  firstLineNumber: number;
  lineCount: number;
  /** The Lodge cell as written (trimmed); blank when the column is absent or empty. */
  lodge: string;
  owner: BookingImportPersonName;
  notes: string;
  /** Empty when the booking cannot be read; `refusals` then says why. */
  guests: BookingImportGuest[];
  /** The earliest guest check-in and latest check-out, `YYYY-MM-DD`. */
  checkIn: string;
  checkOut: string;
  amountMode: BookingImportAmountMode | null;
  totalCents: number;
  guestNightCount: number;
  /** Valid dated beds remain visible even when another field refuses the booking. */
  nightDemand: BookingImportNightDemand[];
  /** Plain reasons the booking cannot be read; empty when it can. No names. */
  refusals: string[];
};

export type BookingImportParseResult =
  | { ok: true; bookings: ParsedImportBooking[]; rowCount: number }
  | { ok: false; error: string; lineNumber?: number };

const normalizeHeader = (header: string) =>
  header.toLowerCase().replace(/[^a-z0-9]/g, "");

const COLUMN_KEY_BY_HEADER = new Map<string, BookingImportColumnKey>(
  BOOKING_IMPORT_COLUMNS.map((column) => [
    normalizeHeader(column.label),
    column.key,
  ]),
);

const MEMBER_GUEST_TYPES = new Set(["member"]);
const NON_MEMBER_GUEST_TYPES = new Set(["nonmember", "guest"]);

const AGE_GROUPS = new Map<string, AgeTier>([
  ["adult", AgeTier.ADULT],
  ["youth", AgeTier.YOUTH],
  ["child", AgeTier.CHILD],
  ["infant", AgeTier.INFANT],
]);

type RawRow = {
  lineNumber: number;
  cell: (key: BookingImportColumnKey) => string;
};

/**
 * Reads the file. A structural fault (no header, a required column missing, a
 * row without a Booking Ref, more rows than the import takes) refuses the
 * whole file; anything wrong inside one booking is that booking's refusal.
 */
export function parseBookingImportCsv(
  text: string,
  options: { dateFormat?: MemberImportDateFormat } = {},
): BookingImportParseResult {
  const parsed = parseMemberImportCsv(text);
  if (!parsed.ok) return parsed;
  const { headers, rows } = parsed.data;
  if (rows.length > MEMBER_IMPORT_MAX_ROWS) {
    return {
      ok: false,
      error: `The file has ${rows.length} rows; an import takes at most ${MEMBER_IMPORT_MAX_ROWS}`,
    };
  }

  const columnIndex = new Map<BookingImportColumnKey, number>();
  for (const [index, header] of headers.entries()) {
    const key = COLUMN_KEY_BY_HEADER.get(normalizeHeader(header));
    if (!key) continue;
    if (columnIndex.has(key)) {
      return { ok: false, error: `The column "${header}" appears twice` };
    }
    columnIndex.set(key, index);
  }
  const missing = BOOKING_IMPORT_COLUMNS.filter(
    (column) => column.required && !columnIndex.has(column.key),
  );
  if (missing.length > 0) {
    return {
      ok: false,
      error: `Missing column${missing.length === 1 ? "" : "s"}: ${missing
        .map((column) => column.label)
        .join(", ")}`,
    };
  }

  const groups = new Map<string, RawRow[]>();
  for (const record of rows) {
    const cell = (key: BookingImportColumnKey) => {
      const index = columnIndex.get(key);
      return index === undefined ? "" : (record.values[index] ?? "").trim();
    };
    if (record.values.every((value) => value.trim() === "")) continue;
    const bookingRef = cell("bookingRef");
    if (!bookingRef) {
      return {
        ok: false,
        error: "Every row needs a Booking Ref",
        lineNumber: record.lineNumber,
      };
    }
    const group = groups.get(bookingRef) ?? [];
    group.push({ lineNumber: record.lineNumber, cell });
    groups.set(bookingRef, group);
  }

  const dateFormat = options.dateFormat ?? DEFAULT_MEMBER_IMPORT_DATE_FORMAT;
  const bookings = Array.from(groups, ([bookingRef, group]) =>
    readBooking(bookingRef, group, dateFormat),
  );
  if (bookings.reduce((sum, booking) => sum + booking.totalCents, 0) > MAX_INTEGER_CENTS) {
    return { ok: false, error: "The file total exceeds the stored integer-cent range; split the file" };
  }
  return {
    ok: true,
    bookings,
    rowCount: bookings.reduce((sum, booking) => sum + booking.lineCount, 0),
  };
}

function readBooking(
  bookingRef: string,
  group: RawRow[],
  dateFormat: MemberImportDateFormat,
): ParsedImportBooking {
  // `groups` only ever holds a group once a row has been pushed to it.
  const first = group[0]!;
  const refusals: string[] = [];
  const refuse = (reason: string) => {
    if (!refusals.includes(reason)) refusals.push(reason);
  };

  const sameOnEveryRow = (key: BookingImportColumnKey, label: string) => {
    const value = first.cell(key);
    if (group.some((row) => row.cell(key).toLowerCase() !== value.toLowerCase())) {
      refuse(`${label} differs between the booking's rows`);
    }
    return value;
  };
  const lodge = sameOnEveryRow("lodge", "Lodge");
  const owner = {
    email: sameOnEveryRow("ownerEmail", "Owner Email"),
    firstName: sameOnEveryRow("ownerFirstName", "Owner First Name"),
    lastName: sameOnEveryRow("ownerLastName", "Owner Last Name"),
  };
  if (!owner.email || !owner.firstName || !owner.lastName) {
    refuse("Owner Email, Owner First Name and Owner Last Name are all needed");
  }
  const notes = group
    .map((row) => row.cell("notes"))
    .filter(Boolean)
    .join("\n");

  // Part-paid (#5005 O2, #5008): marked by Balance Owing on the first row.
  // Refused outright until #5008 ships; the row is still read so its totals
  // land in the refused column.
  if (group.some((row) => row.cell("balanceOwing") || row.cell("balanceDueDate"))) {
    refuse(BOOKING_IMPORT_PART_PAID_REFUSAL);
  }

  type GuestDraft = Omit<BookingImportGuest, "amountCents"> & {
    amountText: string;
  };
  const drafts: GuestDraft[] = [];
  for (const row of group) {
    const line = row.lineNumber;
    const guestType = normalizeHeader(row.cell("guestType"));
    const isMember = MEMBER_GUEST_TYPES.has(guestType);
    if (!isMember && !NON_MEMBER_GUEST_TYPES.has(guestType)) {
      refuse(`Guest Type on line ${line} must be Member or Non-member`);
    }
    const identity = {
      email: isMember ? row.cell("guestEmail") : "",
      firstName: row.cell("guestFirstName"),
      lastName: row.cell("guestLastName"),
    };
    if (!identity.firstName || !identity.lastName) {
      refuse(`Guest First Name and Guest Last Name are needed on line ${line}`);
    }
    if (isMember && !identity.email) {
      refuse(`A member guest needs a Guest Email (line ${line})`);
    }
    let ageTier: AgeTier | null = null;
    if (NON_MEMBER_GUEST_TYPES.has(guestType)) {
      ageTier = AGE_GROUPS.get(row.cell("ageGroup").toLowerCase()) ?? null;
      if (!ageTier) {
        refuse(
          `Age Group on line ${line} must be Adult, Youth, Child or Infant for a non-member`,
        );
      }
    }

    const checkIn = readDate(row.cell("checkIn"), "Check In", line, dateFormat, refuse);
    const checkOut = readDate(row.cell("checkOut"), "Check Out", line, dateFormat, refuse);
    let nights = 0;
    if (checkIn && checkOut) {
      nights = countNightsDateOnly(parseDateOnly(checkIn), parseDateOnly(checkOut));
      if (!(nights > 0)) {
        refuse(
          `Check Out must be after Check In on line ${line} (Check Out is the departure morning)`,
        );
      } else if (nights > BOOKING_IMPORT_MAX_NIGHTS) {
        refuse(`The stay on line ${line} is longer than ${BOOKING_IMPORT_MAX_NIGHTS} nights`);
      }
      const nightsText = row.cell("nights");
      if (nightsText && nights > 0 && nightsText !== String(nights)) {
        refuse(
          `Nights on line ${line} is ${nightsText} but the dates give ${nights}`,
        );
      }
    }

    drafts.push({
      lineNumber: line,
      isMember,
      identity,
      ageTier,
      checkIn: checkIn ?? "",
      checkOut: checkOut ?? "",
      nights,
      amountText: row.cell("amountPaid"),
    });
  }

  const datedDrafts = drafts.filter((draft) => draft.checkIn && draft.checkOut);
  const checkIn = datedDrafts.map((draft) => draft.checkIn).sort()[0] ?? "";
  const checkOut = datedDrafts.map((draft) => draft.checkOut).sort().at(-1) ?? "";
  if (checkIn && checkOut && countNightsDateOnly(parseDateOnly(checkIn), parseDateOnly(checkOut)) > BOOKING_IMPORT_MAX_NIGHTS) {
    refuse(`The booking envelope is longer than ${BOOKING_IMPORT_MAX_NIGHTS} nights`);
  }
  const demand = new Map<string, number>();
  for (const draft of drafts) {
    if (!(draft.nights > 0 && draft.nights <= BOOKING_IMPORT_MAX_NIGHTS)) continue;
    for (const date of eachDateOnlyInRange(parseDateOnly(draft.checkIn), parseDateOnly(draft.checkOut))) {
      const key = formatDateOnly(date);
      demand.set(key, (demand.get(key) ?? 0) + 1);
    }
  }
  const amounts = readAmounts(drafts, refuse);
  const guests: BookingImportGuest[] =
    refusals.length > 0 || amounts === null
      ? []
      : drafts.map((draft, index) => ({
          lineNumber: draft.lineNumber,
          isMember: draft.isMember,
          identity: draft.identity,
          ageTier: draft.ageTier,
          checkIn: draft.checkIn,
          checkOut: draft.checkOut,
          nights: draft.nights,
          amountCents: amounts.perGuestCents[index] ?? 0,
        }));
  return {
    bookingRef,
    firstLineNumber: first.lineNumber,
    lineCount: group.length,
    lodge,
    owner,
    notes,
    guests,
    checkIn,
    checkOut,
    nightDemand: [...demand].sort(([a], [b]) => a.localeCompare(b)).map(([night, beds]) => ({ night, beds })),
    amountMode: amounts?.mode ?? null,
    totalCents: amounts?.totalCents ?? 0,
    guestNightCount: drafts.reduce((sum, draft) => sum + Math.max(draft.nights, 0), 0),
    refusals,
  };
}

function readDate(
  text: string,
  label: string,
  line: number,
  dateFormat: MemberImportDateFormat,
  refuse: (reason: string) => void,
): string | null {
  if (!text) {
    refuse(`${label} is missing on line ${line}`);
    return null;
  }
  const result = normalizeMemberImportDateValue(text, dateFormat);
  if (!result.ok) {
    refuse(`${label} on line ${line} ${result.error}`);
    return null;
  }
  return result.value;
}

/**
 * Either every guest row carries its own amount, or only the first row carries
 * the booking's total, shared evenly across the booking's guest-nights. A mix
 * is refused, and a blank amount is missing, never zero.
 */
function readAmounts(
  drafts: { lineNumber: number; nights: number; amountText: string }[],
  refuse: (reason: string) => void,
): { mode: BookingImportAmountMode; totalCents: number; perGuestCents: number[] } | null {
  const [first, ...rest] = drafts;
  if (!first) return null;
  if (!first.amountText) {
    refuse(`Amount Paid is missing on line ${first.lineNumber}`);
    return null;
  }
  const filled = rest.filter((draft) => draft.amountText);
  if (filled.length > 0 && filled.length < rest.length) {
    refuse(
      "Amount Paid must be on every guest row or on the first row only, not a mix",
    );
    return null;
  }
  const cents = drafts.map((draft) =>
    draft.amountText
      ? parseDecimalDollarsToCents(draft.amountText)
      : null,
  );
  const malformed = drafts.find(
    (draft, index) => draft.amountText && cents[index] === null,
  );
  if (malformed) {
    refuse(
      `Amount Paid on line ${malformed.lineNumber} is not a dollar amount like 540.00`,
    );
    return null;
  }

  if (rest.length === 0 || filled.length > 0) {
    const perGuestCents = cents.map((value) => value ?? 0);
    return {
      mode: "PER_GUEST",
      totalCents: perGuestCents.reduce((sum, value) => sum + value, 0),
      perGuestCents,
    };
  }

  const totalCents = cents[0] ?? 0;
  const guestNights = drafts.reduce((sum, draft) => sum + Math.max(draft.nights, 0), 0);
  const nightShares = allocateCentsEvenly(totalCents, Math.min(guestNights, drafts.length * BOOKING_IMPORT_MAX_NIGHTS));
  let cursor = 0;
  const perGuestCents = drafts.map((draft) => {
    const nights = Math.max(draft.nights, 0);
    const share = nightShares
      .slice(cursor, cursor + nights)
      .reduce((sum, value) => sum + value, 0);
    cursor += nights;
    return share;
  });
  return { mode: "BOOKING_TOTAL", totalCents, perGuestCents };
}
