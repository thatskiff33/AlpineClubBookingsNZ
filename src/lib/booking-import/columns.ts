/**
 * The paid-booking import's columns and how a file's columns map onto them
 * (#5005). No database and no Prisma import, so the import screen can read a
 * file's headers in the browser and propose the same mapping the server
 * applies.
 */
import { normalizeMemberImportHeader } from "@/lib/member-csv-import";

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

export type BookingImportColumnKey = (typeof BOOKING_IMPORT_COLUMNS)[number]["key"];

/** Which file column (by position) holds each import column; null or absent is unmapped. */
export type BookingImportColumnMapping = Partial<Record<BookingImportColumnKey, number | null>>;

const COLUMN_KEY_BY_HEADER = new Map<string, BookingImportColumnKey>(
  BOOKING_IMPORT_COLUMNS.map((column) => [normalizeMemberImportHeader(column.label), column.key]),
);

/**
 * The mapping the screen starts from: each import column a file header names,
 * read the way the parser reads headers when no mapping is given. A header
 * named twice maps its first column, for the officer to correct.
 */
export function inferBookingImportColumnMapping(headers: readonly string[]): BookingImportColumnMapping {
  const mapping: BookingImportColumnMapping = {};
  for (const [index, header] of headers.entries()) {
    const key = COLUMN_KEY_BY_HEADER.get(normalizeMemberImportHeader(header));
    if (key && mapping[key] === undefined) mapping[key] = index;
  }
  return mapping;
}

/**
 * Where each import column is in the file. Without a mapping the headers
 * decide, and a header named twice refuses the file. With one (the officer's,
 * from the screen) each column names a file column by position; a position
 * outside the file, or one file column mapped twice, refuses the file. Either
 * way a required column left unmapped refuses it.
 */
export function readBookingImportColumns(
  headers: readonly string[],
  mapping?: BookingImportColumnMapping,
): { ok: true; columnIndex: Map<BookingImportColumnKey, number> } | { ok: false; error: string } {
  const columnIndex = new Map<BookingImportColumnKey, number>();
  if (mapping) {
    const taken = new Map<number, string>();
    for (const column of BOOKING_IMPORT_COLUMNS) {
      const index = mapping[column.key];
      if (index === null || index === undefined) continue;
      if (!Number.isInteger(index) || index < 0 || index >= headers.length) {
        return { ok: false, error: `"${column.label}" is mapped to a column the file does not have` };
      }
      const other = taken.get(index);
      if (other) return { ok: false, error: `One file column is mapped to both "${other}" and "${column.label}"` };
      taken.set(index, column.label);
      columnIndex.set(column.key, index);
    }
  } else {
    for (const [index, header] of headers.entries()) {
      const key = COLUMN_KEY_BY_HEADER.get(normalizeMemberImportHeader(header));
      if (!key) continue;
      if (columnIndex.has(key)) return { ok: false, error: `The column "${header}" appears twice` };
      columnIndex.set(key, index);
    }
  }
  const missing = BOOKING_IMPORT_COLUMNS.filter((column) => column.required && !columnIndex.has(column.key));
  if (missing.length > 0) {
    return {
      ok: false,
      error: `Missing column${missing.length === 1 ? "" : "s"}: ${missing.map((column) => column.label).join(", ")}`,
    };
  }
  return { ok: true, columnIndex };
}
